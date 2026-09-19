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

async function pluginMessages(k, sessionId) {
  const facts = await k.ctx.sessionQuery.readSession(sessionId)
  return facts.events.filter(e => e.type === 'user/message' && e.data.source?.kind === 'plugin')
}

test('recovery work for one conversation never spills into another', { timeout: 20000 }, async t => {
  const args = JSON.stringify({ questions: [{ id: 'destination', question: 'Which destination do you choose?' }] })
  const entered = Promise.withResolvers()
  const { k, api, exits } = await fixture(t, { userQuestions: true, response: request => request.sessionId !== 'session-spill-waiting' ? 'ordinary answer' : ({ chunks: [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: 'ask-destination', name: 'ask_user_question', argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'ask-destination', name: 'ask_user_question', arguments: args } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ] }) })
  k.ctx.on('user-questions/request', request => { entered.resolve(); return waitForAbort(request.signal) })
  const waiting = await k.create('session-spill-waiting')
  const other = await k.create('session-spill-other')
  waiting.followup(k.message('Ask me where to go, then continue.'))
  await entered.promise; await k.flush(waiting)
  // A restart scan claims the conversation that is waiting for the human.
  await api.recovery.discover()
  await api.poll()
  assert.ok(api.recovery.status().pending.some(j => j.sessionId === waiting.id && j.status === 'waiting-user'),
    'an unanswered question keeps its recovery waiting')
  const beforeOther = k.requests.length
  other.followup(k.message('unrelated ordinary work', { id: 'spill-other-1' }))
  await other.whenIdle(); await k.flush(other)
  const afterOther = k.requests.length
  for (let cycle = 0; cycle < 40; cycle++) await api.poll()
  assert.equal(afterOther, beforeOther + 1, 'the unrelated conversation runs exactly its own turn')
  assert.equal(k.requests.length, afterOther, 'no extra model turn is started anywhere')
  assert.deepEqual(await pluginMessages(k, other.id), [], 'the unrelated conversation receives no plugin message')
  assert.deepEqual(await pluginMessages(k, waiting.id), [], 'the waiting conversation is neither continued nor re-asked')
  assert.equal(api.control.status().holding, 0, 'nothing is held')
  assert.deepEqual(exits, [])
})

test('steady state touches no conversation at all' , { timeout: 20000 }, async t => {
  const { k, api, exits } = await fixture(t)
  const idle = await k.create('session-steady-idle')
  const worker = await k.create('session-steady-worker')
  const goal = k.ctx.goals.create(worker, { objective: 'keep working on its own task', maxGoalRounds: 3 })
  k.ctx.goals.disarm(worker)
  const before = k.requests.length
  // Ordinary activity in both conversations, with nothing restarting.
  idle.followup(k.message('an ordinary user turn', { id: 'steady-idle-1' }))
  worker.followup(k.message('another ordinary turn', { id: 'steady-worker-1' }))
  await idle.whenIdle(); await worker.whenIdle()
  await k.flush(idle); await k.flush(worker)
  const turnsAfterWork = k.requests.length
  // Many poll cycles with no restart pending and no recovery work outstanding.
  for (let cycle = 0; cycle < 40; cycle++) await api.poll()
  assert.equal(k.requests.length, turnsAfterWork, 'the plugin never starts a model turn on its own')
  assert.deepEqual(await pluginMessages(k, idle.id), [], 'no plugin message reaches the idle conversation')
  assert.deepEqual(await pluginMessages(k, worker.id), [], 'no plugin message reaches the working conversation')
  assert.equal(k.ctx.goals.get(worker).activation, 'disarmed', 'goal execution is never restarted outside recovery')
  assert.equal(api.control.status().holding, 0, 'no conversation is ever held')
  assert.equal(api.control.status().pending, null)
  assert.equal(api.recovery.status().pending.length, 0, 'nothing is recorded while nothing is restarting')
  assert.deepEqual(exits, [])
  assert.equal(k.errors.length, 0)
  assert.equal(k.requests.length, before + 2, 'exactly the two turns the user asked for')
})
