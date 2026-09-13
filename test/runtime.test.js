import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import * as plugin from '../lib/index.js'
import { createModuleLoader, createNativeKernel, waitForAbort } from './native-kernel.mjs'
const loadModule = createModuleLoader(process.env.DSH_NATIVE_TEST_RESOLVE_FROM ?? new URL('../package.json', import.meta.url))

async function fixture(t, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), 'keep-going-runtime-'))
  const k = await createNativeKernel({ root, loadModule, goalRounds: false, ...extra })
  t.after(async () => { await k.close(); await rm(root, { recursive: true, force: true }) })
  const commands = await loadModule('@deepseek-ai/dsh-commands')
  await k.ctx.plugin(commands.default ?? commands)
  const exits = []
  k.ctx.provide('appExit', code => exits.push(code))
  const fork = k.ctx.plugin(plugin, { stateDirectory: join(root, 'recovery'), drainTimeoutMs: 1000, scanIntervalMs: 60000 })
  await fork
  const api = k.ctx.get('keepGoing')
  assert.ok(api, 'real Cordis mounted the plugin and its service dependencies')
  await api.ready
  return { k, api, exits, root }
}

async function until(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return predicate()
}

test('a scheduled restart leaves conversations working, preserves owner and supports cancellation', { timeout: 15000 }, async t => {
  const { k, api, exits } = await fixture(t)
  const a = await k.create('session-runtime-a')
  k.ctx.goals.create(a, { objective: 'finish the runtime task', maxGoalRounds: 3 })
  const before = k.ctx.goals.get(a).activation
  const accepted = await api.control.request(a.id, {})
  assert.equal(accepted.ok, true)
  assert.equal(api.control.status().holding, 0, 'a waiting restart holds no conversation')
  assert.equal(k.ctx.goals.get(a).activation, before, 'a waiting restart does not touch goal activation')
  a.followup(k.message('arrived while restart was waiting', { id: 'msg-during-drain' }))
  assert.ok(await until(() => k.requests.length === 1), 'new input starts a turn at once instead of being parked')
  assert.equal(a.inbox.nextTurn.length, 0, 'nothing is left queued in the inbox')
  await a.whenIdle(); await k.flush(a)
  const denied = await api.control.request('other-owner', { force: true, waitMs: 1000 })
  assert.equal(denied.ok, false)
  assert.equal(api.control.status().pending.owner, a.id)
  assert.equal((await api.control.cancel('other-owner')).ok, false)
  const canceled = await k.ctx.commands.execute(a, '/cancel-restart', [], new AbortController().signal)
  assert.equal(canceled.result.kind, 'success', 'the requesting conversation can cancel')
  assert.equal(api.control.status().pending, null)
  assert.equal(api.control.status().holding, 0, 'cancelling leaves no lock behind')
  assert.equal(k.ctx.goals.get(a).activation, before, 'cancelling changes no goal state')
  assert.equal(k.requests.length, 1)
  assert.deepEqual(exits, [], 'nothing exited')
})

test('a restart waits for work in another conversation, then exits with the supervisor code', { timeout: 15000 }, async t => {
  const entered = Promise.withResolvers(), gate = Promise.withResolvers()
  t.after(() => gate.resolve())
  const { k, api, exits } = await fixture(t, { onRequest: async (request, { agent }) => {
    if (agent?.id !== 'session-runtime-busy') return
    entered.resolve(); await gate.promise
  } })
  const caller = await k.create('session-runtime-caller')
  const busy = await k.create('session-runtime-busy')
  assert.equal((await api.control.request(caller.id, { continuePrompt: 'caller only' })).ok, true)
  busy.followup(k.message('work in another conversation', { id: 'msg-busy' }))
  await entered.promise
  await api.control.check()
  assert.deepEqual(exits, [], 'a healthy running turn is never cut without force')
  assert.equal(api.control.status().holding, 0, 'waiting for work holds no conversation')
  assert.equal(caller.status, 'idle', 'the waiting restart does not hold other conversations either')
  gate.resolve()
  await busy.whenIdle(); await k.flush(busy)
  await api.control.check()
  assert.deepEqual(exits, [75], 'the supervisor restart code is used')
  const jobs = api.recovery.status().pending
  assert.ok(jobs.some(j => j.kind === 'request' && j.sessionId === caller.id && j.prompt === 'caller only'),
    'the caller-only continuation survives the exit')
})

test('force is the only thing that cuts running work at the deadline', { timeout: 15000 }, async t => {
  const entered = Promise.withResolvers(), gate = Promise.withResolvers()
  t.after(() => gate.resolve())
  const { k, api, exits } = await fixture(t, { onRequest: async () => { entered.resolve(); await gate.promise } })
  const a = await k.create('session-runtime-force')
  assert.equal((await api.control.request(a.id, { waitMs: 1000, force: true })).ok, true)
  a.followup(k.message('work that will be cut', { id: 'msg-cut' }))
  await entered.promise
  await api.control.check()
  assert.deepEqual(exits, [], 'the deadline alone is not permission to cut work')
  await new Promise(resolve => setTimeout(resolve, 1100))
  await api.control.check()
  assert.deepEqual(exits, [75], 'explicit force authorizes the deadline cut')
  const jobs = api.recovery.status().pending
  assert.ok(jobs.some(j => j.sessionId === a.id && j.savedInput?.id === 'msg-cut' && j.disposalExpected),
    'the cut work is saved durably before the exit')
})

test('an actual unanswered user question permits safe restart without answering it', { timeout: 15000 }, async t => {
  const args = JSON.stringify({ questions: [{ id: 'destination', question: 'Which destination do you choose?' }] })
  const { k, api, exits } = await fixture(t, { userQuestions: true, response: () => ({ chunks: [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: 'ask-destination', name: 'ask_user_question', argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'ask-destination', name: 'ask_user_question', arguments: args } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ] }) })
  const entered = Promise.withResolvers()
  let questions = 0
  k.ctx.on('user-questions/request', request => { questions++; entered.resolve(); return waitForAbort(request.signal) })
  const a = await k.create('session-waiting-restart')
  a.followup(k.message('Ask which destination I want before proceeding.'))
  await entered.promise; await k.flush(a)
  assert.equal(a.status, 'running')
  assert.equal((await api.control.request(a.id, {})).ok, true)
  await api.control.check()
  assert.deepEqual(exits, [75], 'waiting for a person need not prevent saving and restarting')
  assert.equal(questions, 1, 'never re-asked or answered automatically')
  assert.equal(k.requests.length, 1)
  const facts = await k.ctx.sessionQuery.readSession(a.id)
  assert.ok(facts.events.some(e => e.type === 'tool/call' && e.data.callId === 'ask-destination'))
})
