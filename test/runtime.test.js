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

test('real Cordis mounts plugin, holds new input during drain, preserves owner and supports cancellation', { timeout: 15000 }, async t => {
  const { k, api, exits } = await fixture(t)
  const a = await k.create('session-runtime-a')
  const accepted = await api.control.request(a.id, {})
  assert.equal(accepted.ok, true)
  a.followup(k.message('arrived while restart was waiting', { id: 'msg-during-drain' }))
  assert.equal(a.status, 'idle', 'native maintenance keeps new work queued')
  assert.equal(a.inbox.nextTurn.length, 1)
  assert.equal(k.requests.length, 0)
  const denied = await api.control.request('other-owner', { force: true, waitMs: 1000 })
  assert.equal(denied.ok, false)
  assert.equal(api.control.status().pending.owner, a.id)
  assert.equal((await api.control.cancel('other-owner')).ok, false)
  const canceled = await k.ctx.commands.execute(a, '/cancel-restart', [], new AbortController().signal)
  assert.equal(canceled.result.kind, 'success', 'the user can cancel even while the model is held')
  await a.whenIdle(); await k.flush(a)
  assert.equal(k.requests.length, 1)
  assert.equal(exits.length, 0)
})

test('restart uses supervisor restart code and leaves durable pending arrivals', { timeout: 15000 }, async t => {
  const { k, api, exits } = await fixture(t)
  const a = await k.create('session-runtime-exit')
  assert.equal((await api.control.request(a.id, { continuePrompt: 'caller only' })).ok, true)
  a.followup(k.message('new input', { id: 'msg-after-request' }))
  await api.control.check()
  assert.deepEqual(exits, [75])
  const jobs = api.recovery.status().pending
  assert.ok(jobs.some(j => j.kind === 'request' && j.sessionId === a.id && j.prompt === 'caller only'))
  assert.ok(jobs.some(j => j.kind === 'input' && j.inputId === 'msg-after-request' && j.disposalExpected))
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
