import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createRecoveryMessage, isRecoveryMessage } from '../lib/messages.js'
import { createNativeAdapter } from '../lib/native.js'
import { createRecovery } from '../lib/recovery.js'
import { createStore } from '../lib/store.js'
import { outstandingWaits } from '../lib/waiting.js'
import { createModuleLoader, createNativeKernel } from './native-kernel.mjs'

const loadModule = createModuleLoader(process.env.DSH_NATIVE_TEST_RESOLVE_FROM ?? new URL('../package.json', import.meta.url))
const options = { timeout: 15000 }
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'keep-going-protocol-')), kernels = []
  t.after(async () => {
    try { for (const k of kernels.toReversed()) await k.close() }
    finally { await rm(root, { recursive: true, force: true }) }
  })
  const store = createStore(join(root, 'recovery'))
  const boot = async () => {
    const k = await createNativeKernel({ root, loadModule, goalRounds: false }); kernels.push(k)
    const adapter = createNativeAdapter(k.ctx)
    const recovery = createRecovery({ adapter, store, config: { retryMinMs: 1, retryMaxMs: 10 }, log: { log() {}, error() {} } })
    t.after(() => recovery.stop())
    return { k, adapter, recovery }
  }
  return { boot, store }
}

test('native admission accepts recovery messages and ordered-inbox wake using the current source', options, async t => {
  const { boot } = await fixture(t)
  const { k, adapter } = await boot()
  const agent = await k.create('session-protocol-messages')
  const continuation = createRecoveryMessage('protocol-continuation', 'Resume the unfinished task')
  adapter.queue(agent, continuation)
  await agent.whenIdle(); await k.flush(agent)
  const a = k.message('First queued human input', { id: 'protocol-input-A' })
  const b = k.message('Second queued human input', { id: 'protocol-input-B' })
  agent.inbox.append('next-turn', a); agent.inbox.append('next-turn', b)
  adapter.queue(agent, a, createRecoveryMessage('protocol-wake', 'Never reorder the input'))
  await agent.whenIdle(); await k.flush(agent)
  const messages = agent.session.snapshotEvents().filter(e => e.type === 'user/message').map(e => e.data)
  const generated = messages.filter(isRecoveryMessage)
  assert.deepEqual(generated.map(m => m.id), [continuation.id, 'protocol-wake-wake'])
  assert.ok(generated.every(m => m.source.kind === 'dsh-keep-going' && !('plugin' in m.source)))
  assert.deepEqual(messages.filter(m => m.source.kind === 'user').map(m => m.id), [a.id, b.id])
  assert.equal((await adapter.inspect(agent.id)).receipts.get(continuation.id).state, 'admitted')
  assert.equal(k.errors.length, 0)
})

test('native crash closers retain questions and approvals until real successful tool messages', options, async () => {
  const { ToolCallRecovery } = await loadModule('@deepseek-ai/dsh-session')
  const { createToolResultMessage } = await loadModule('@deepseek-ai/dsh-llm')
  const question = { id: 'format', question: 'Which format?' }
  const args = JSON.stringify({ questions: [question] })
  const calls = ['started-question', 'unstarted-action'].map(id => ({ type: 'tool-call', id,
    name: id === 'started-question' ? 'ask_user_question' : 'publish', arguments: args }))
  const assistant = { seq: 0, time: 1, type: 'assistant/message', data: { turn: 1, step: 1,
    message: { role: 'assistant', content: calls } } }
  const call = { seq: 1, time: 1, type: 'tool/call', data: { turn: 1, step: 1,
    callId: calls[0].id, name: calls[0].name, arguments: args } }
  const approvals = calls.map((entry, index) => ({ seq: index + 2, time: 1, type: 'approval/asked',
    data: { id: `approval-${entry.id}`, callId: entry.id, toolName: entry.name } }))
  const history = [assistant, call, ...approvals]
  const recovery = new ToolCallRecovery()
  for (const event of history) recovery.observe(event)
  const closers = recovery.results()
  assert.deepEqual(closers.map(e => e.data.error.code), ['TOOL_OUTCOME_UNKNOWN', 'TOOL_NOT_STARTED'])
  assert.ok(closers.every(e => e.data.message.role === 'tool' && e.data.message.isError))
  assert.equal(outstandingWaits([...history, ...closers]).length, 3,
    'real kernel-generated synthetic failures are neither answers nor approval settlements')
  const successes = calls.map((entry, index) => ({ seq: closers.at(-1).seq + index + 1, type: 'tool/result', data: {
    message: createToolResultMessage({ callId: entry.id, isError: false,
      content: [{ type: 'text', text: JSON.stringify({ answers: [{ id: question.id, selected: ['JSON'] }] }) }] }),
  } }))
  assert.deepEqual(outstandingWaits([...history, ...closers, ...successes]), [])
})

test('native live snapshots refresh archive and unarchive at an unchanged log cursor', options, async t => {
  const { boot } = await fixture(t)
  const { k, adapter } = await boot()
  const agent = await k.create('session-live-archive-cache')
  await k.flush(agent)
  const before = adapter.snapshot(agent)
  await k.ctx.workspaceRegistry.archiveSession(agent.id)
  const archived = adapter.snapshot(agent)
  assert.equal(archived.cursor, before.cursor)
  assert.equal(archived.receipts, before.receipts, 'reuse the log fold, not registry state')
  assert.equal(before.archived, false, 'do not mutate the earlier snapshot')
  assert.equal(archived.archived, true)
  assert.equal((await adapter.inspect(agent.id)).archived, true)
  await k.ctx.workspaceRegistry.unarchiveSession(agent.id)
  const unarchived = adapter.snapshot(agent)
  assert.equal(unarchived.cursor, before.cursor)
  assert.equal(unarchived.archived, false)
  assert.equal(archived.archived, true)
})

test('native cold archive after discovery prevents cached recovery and restore until unarchived', options, async t => {
  const { boot, store } = await fixture(t)
  const first = await boot()
  const agent = await first.k.create('session-cold-archive-cache')
  first.k.ctx.goals.create(agent, { objective: 'Recover only while not archived', maxGoalRounds: 3 })
  await first.k.flush(agent); await first.k.close()
  const second = await boot()
  const { k, adapter, recovery } = second
  const before = await adapter.inspect(agent.id)
  await recovery.discover()
  assert.equal(Object.values(store.read().jobs).length, 1, 'discovery has cached eligible work')
  await k.ctx.workspaceRegistry.archiveSession(agent.id)
  const archived = await adapter.inspect(agent.id)
  assert.equal(archived.cursor, before.cursor, 'archive does not append a log event')
  assert.equal(archived.receipts, before.receipts)
  assert.equal(archived.archived, true)
  assert.deepEqual(await adapter.list(), [])
  await assert.rejects(() => adapter.restore(agent.id), /archived session/)
  await recovery.tick()
  assert.equal(k.ctx.agents.list().length, 0, 'no cold agent was restored')
  assert.equal(k.requests.length, 0, 'no continuation or goal round was sent')
  assert.deepEqual(store.read().jobs, {})
  await k.ctx.workspaceRegistry.unarchiveSession(agent.id)
  assert.equal((await adapter.inspect(agent.id)).archived, false)
  await recovery.discover(); await recovery.tick()
  assert.equal(k.ctx.goals.get(k.ctx.agents.get(agent.id)).activation, 'armed')
  assert.deepEqual(store.read().jobs, {})
  assert.equal(k.errors.length, 0)
})
