import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createStore } from '../lib/store.js'
import { createRecovery } from '../lib/recovery.js'
import { createNativeAdapter } from '../lib/native.js'
import { createModuleLoader, createNativeKernel, waitForAbort } from './native-kernel.mjs'

const loadModule = createModuleLoader(process.env.DSH_NATIVE_TEST_RESOLVE_FROM ?? new URL('../package.json', import.meta.url))
const config = { retryMinMs: 10, retryMaxMs: 1000 }
const silent = { log() {}, error() {} }
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'keep-going-recover-')), kernels = []
  t.after(async () => {
    for (const k of kernels.toReversed()) await k.close()
    await rm(root, { recursive: true, force: true })
  })
  const store = createStore(join(root, 'recovery'))
  const boot = async extra => {
    const k = await createNativeKernel({ root, loadModule, ...extra }); kernels.push(k)
    const adapter = createNativeAdapter(k.ctx)
    const recovery = createRecovery({ adapter, store, config, log: silent })
    return { k, adapter, recovery }
  }
  return { root, store, boot }
}
async function finish(k) {
  for (const a of k.ctx.agents.list()) { await a.whenIdle(); await k.flush(a) }
}

test('completed ordinary task remains cold, with no new message after restart', { timeout: 15000 }, async t => {
  const { boot, store } = await fixture(t)
  const first = await boot({ goalRounds: false })
  const a = await first.k.create('session-complete')
  a.followup(first.k.message('do a task'))
  await finish(first.k); await first.k.close()
  const second = await boot({ goalRounds: false })
  await second.recovery.discover(); await second.recovery.tick()
  assert.equal(second.k.ctx.agents.list().length, 0)
  assert.equal(second.k.requests.length, 0)
  assert.deepEqual(store.read().jobs, {})
})

test('unfinished ordinary task cold-restores with history and continues once', { timeout: 15000 }, async t => {
  const { boot, store } = await fixture(t)
  const entered = Promise.withResolvers()
  const first = await boot({ goalRounds: false, onRequest: async r => { entered.resolve(); await waitForAbort(r.signal) } })
  const a = await first.k.create('session-incomplete')
  a.followup(first.k.message('original task, keep this context'))
  await entered.promise; await first.k.flush(a)
  await first.recovery.checkpoint(true)
  assert.equal(Object.keys(store.read().jobs).length, 1)
  await first.k.close()
  const second = await boot({ goalRounds: false })
  assert.equal(second.k.ctx.agents.list().length, 0, 'no browser/client session opened')
  await second.recovery.discover(); await second.recovery.tick(); await finish(second.k)
  await second.recovery.tick(); await second.recovery.tick()
  assert.equal(second.k.requests.length, 1)
  assert.ok(second.k.requests[0].messages.some(m => m.content.some(b => b.text?.includes('original task'))))
  assert.deepEqual(store.read().jobs, {})
  assert.equal(second.k.errors.length, 0)
})

test('without restart marker all original active goals restore, paused and complete do not', { timeout: 15000 }, async t => {
  const { boot, store } = await fixture(t)
  const first = await boot({ goalRounds: false })
  for (const phase of ['active', 'paused', 'complete']) {
    const a = await first.k.create(`session-goal-${phase}`)
    const g = first.k.ctx.goals.create(a, { objective: `finish ${phase}`, maxGoalRounds: 3 })
    if (phase === 'paused') first.k.ctx.goals.pause(a, g)
    if (phase === 'complete') first.k.ctx.goals.complete(a, g)
    await first.k.flush(a)
  }
  await first.k.close()
  assert.deepEqual(store.read().jobs, {}, 'no cooperation from the previous process')
  const second = await boot({ onRequest: (_r, { ctx, agent }) => {
    const g = ctx.goals.get(agent)
    ctx.goals.complete(agent, { id: g.id, revision: g.revision })
  } })
  await second.recovery.discover(); await second.recovery.tick(); await finish(second.k)
  assert.equal(second.k.requests.length, 1)
  assert.deepEqual(second.k.ctx.agents.list().map(a => a.id), ['session-goal-active'])
  assert.equal(second.k.ctx.goals.get(second.k.ctx.agents.get('session-goal-active')).phase, 'complete')
  assert.equal(second.k.errors.length, 0)
})

test('a later native goal disarm is not re-armed again in the same process', { timeout: 15000 }, async t => {
  const { boot, store } = await fixture(t)
  const first = await boot({ goalRounds: false })
  const a = await first.k.create('session-no-rearm-loop')
  first.k.ctx.goals.create(a, { objective: 'a goal whose driver errors after restore', maxGoalRounds: 3 })
  await first.k.flush(a); await first.k.close()
  const second = await boot({ goalRounds: false })
  let resumeCalls = 0
  const resumeGoal = second.adapter.resumeGoal
  second.adapter.resumeGoal = (agent, goal) => { resumeCalls++; return resumeGoal(agent, goal) }
  await second.recovery.discover(); await second.recovery.tick()
  const restored = second.k.ctx.agents.get(a.id)
  assert.equal(resumeCalls, 1)
  assert.equal(second.k.ctx.goals.get(restored).activation, 'armed')
  assert.deepEqual(store.read().jobs, {})
  // Native lifecycle now disarms it (driver error, limit, user action). The
  // plugin must NOT loop re-arms: that would be periodic session restarting.
  second.k.ctx.goals.disarm(restored)
  await second.k.flush(restored)
  second.recovery.observeEvent(restored, { type: 'goal/change', data: { operation: 'disarm' } })
  await second.recovery.discoverSession(a.id)
  await second.recovery.tick(); await second.recovery.tick()
  assert.equal(resumeCalls, 1, 'one re-arm per restart, then DSH owns the lifecycle')
  assert.equal(second.k.ctx.goals.get(restored).activation, 'disarmed')
  assert.equal(second.k.errors.length, 0)
})

test('temporary delivery failure survives another coordinator and retries with one message', { timeout: 15000 }, async t => {
  const { boot, store } = await fixture(t)
  const entered = Promise.withResolvers()
  const first = await boot({ goalRounds: false, onRequest: async r => { entered.resolve(); await waitForAbort(r.signal) } })
  const a = await first.k.create('session-retry')
  a.followup(first.k.message('original task'))
  await entered.promise; await first.k.flush(a); await first.recovery.checkpoint(true); await first.k.close()
  const second = await boot({ goalRounds: false })
  const queue = second.adapter.queue
  second.adapter.queue = () => { throw new Error('temporary delivery failure') }
  await second.recovery.discover(); await second.recovery.tick()
  const pending = Object.values(store.read().jobs)
  assert.equal(pending.length, 1); assert.equal(pending[0].status, 'retrying')
  assert.equal(second.k.requests.length, 0)
  second.adapter.queue = queue
  const again = createRecovery({ adapter: second.adapter, store, config, log: silent })
  await again.retry(); await finish(second.k); await again.tick()
  assert.equal(second.k.requests.length, 1)
  assert.deepEqual(store.read().jobs, {})
})

test('waking a native pending inbox keeps original A then B order', { timeout: 15000 }, async t => {
  const { boot } = await fixture(t)
  const { k, adapter } = await boot({ goalRounds: false })
  const a = await k.create('session-input-order')
  const first = k.message('first input', { id: 'msg-order-A' })
  const second = k.message('second input', { id: 'msg-order-B' })
  a.inbox.append('next-turn', first)
  a.inbox.append('next-turn', second)
  await k.flush(a)
  assert.equal(a.status, 'idle')
  adapter.queue(a, first, k.message('neutral recovery', { id: 'msg-order-nudge',
    source: { kind: 'plugin', plugin: 'dsh-keep-going', form: 'instructions' } }))
  await a.whenIdle(); await k.flush(a)
  const order = a.session.snapshotEvents().filter(e => e.type === 'user/message' && e.data.source.kind === 'user').map(e => e.data.id)
  assert.deepEqual(order, [first.id, second.id])
  assert.equal(k.requests.length, 2)
  assert.equal(k.errors.length, 0)
})
