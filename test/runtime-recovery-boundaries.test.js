import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import * as plugin from '../lib/index.js'
import { createNativeAdapter } from '../lib/native.js'
import { createRecovery } from '../lib/recovery.js'
import { createStore } from '../lib/store.js'
import { isRecoveryMessage } from '../lib/messages.js'
import { createModuleLoader, createNativeKernel, waitForAbort } from './native-kernel.mjs'

const loadModule = createModuleLoader(process.env.DSH_NATIVE_TEST_RESOLVE_FROM ?? new URL('../package.json', import.meta.url))
const options = { timeout: 15000 }
const silent = { log() {}, error() {} }

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'keep-going-boundaries-'))
  const kernels = []
  t.after(async () => {
    for (const k of kernels.toReversed()) await k.close()
    assert.equal(resolve(root), root)
    assert.ok(root.startsWith(join(tmpdir(), 'keep-going-boundaries-')))
    await rm(root, { recursive: true, force: true })
  })
  async function boot(extra = {}, mount = true) {
    const k = await createNativeKernel({ root, loadModule, goalRounds: false, ...extra })
    kernels.push(k)
    const exits = []
    if (!mount) return { k, exits }
    const commands = await loadModule('@deepseek-ai/dsh-commands')
    await k.ctx.plugin(commands.default ?? commands)
    k.ctx.provide('appExit', code => exits.push(code))
    await k.ctx.plugin(plugin, { stateDirectory: join(root, 'recovery') })
    const api = k.ctx.get('keepGoing')
    await api.ready
    return { k, api, exits }
  }
  return { root, boot }
}

async function drain(k, api, cycles = 5) {
  for (let i = 0; i < cycles; i++) {
    for (const agent of k.ctx.agents.list()) { await agent.whenIdle(); await k.flush(agent) }
    await api.poll()
    await new Promise(resolve => setImmediate(resolve))
  }
}

for (const goal of [false, true]) {
  test(`real plugin events settle answered restart question${goal ? ' and resume subsequent goal rounds' : ''}`, options, async t => {
    const { boot } = await fixture(t)
    const entered = Promise.withResolvers()
    const args = JSON.stringify({ questions: [{ id: 'format', question: 'Which output format?' }] })
    const first = await boot({ userQuestions: true, response: () => ({ chunks: [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: 'ask-format', name: 'ask_user_question', argumentsDelta: args },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'ask-format', name: 'ask_user_question', arguments: args } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ] }) }, false)
    first.k.ctx.on('user-questions/request', request => { entered.resolve(); return waitForAbort(request.signal) })
    const original = await first.k.create(`session-answer-${goal}`)
    if (goal) first.k.ctx.goals.create(original, { objective: 'Ask for the format, then finish the report over subsequent rounds.', maxGoalRounds: 4 })
    original.followup(first.k.message('Ask me for the format before finishing.'))
    await entered.promise
    await first.k.flush(original)
    await first.k.close()

    const next = await boot({ userQuestions: true, goalRounds: goal,
      onRequest(_request, { ctx, agent, index }) {
        // The reply itself is NOT goal completion. A later native goal round must run.
        if (goal && index === 1) {
          const current = ctx.goals.get(agent)
          assert.equal(current.activation, 'armed')
          assert.equal(current.roundsStarted, 1)
          ctx.goals.complete(agent, { id: current.id, revision: current.revision })
        }
      },
      response: (_request, { index }) => index === 0 ? 'Format received; further goal work remains.' : 'Report finished.',
    })
    const resumed = next.k.ctx.agents.get(original.id)
    assert.ok(resumed)
    assert.equal(next.k.requests.length, 0)
    assert.equal(next.api.recovery.status().pending[0].status, 'waiting-user')
    if (goal) assert.equal(next.k.ctx.goals.get(resumed).activation, 'disarmed')
    resumed.followup(next.k.message('JSON. Continue with the report.'))
    // No discoverSession/reconcile/complete call from the test after the reply.
    await drain(next.k, next.api)
    assert.equal(next.k.requests.length, goal ? 2 : 1)
    assert.deepEqual(next.api.recovery.status().pending, [])
    if (goal) assert.equal(next.k.ctx.goals.get(resumed).phase, 'complete')
    assert.equal(resumed.session.snapshotEvents().filter(e => e.type === 'user/message' && isRecoveryMessage(e.data)).length, 0)
    assert.deepEqual(next.exits, [])
    assert.deepEqual(next.k.errors, [])
  })
}

test('canceling a prepared restart never re-arms a live disarmed goal', options, async t => {
  const { boot } = await fixture(t)
  const { k, api, exits } = await boot()
  const a = await k.create('session-canceled-restart')
  k.ctx.goals.create(a, { objective: 'Do not restart this goal without an actual restart.', maxGoalRounds: 3 })
  k.ctx.goals.disarm(a)
  await k.flush(a)
  assert.equal((await api.control.request(a.id, {})).ok, true)
  const prepared = api.recovery.status().pending.find(j => j.kind === 'goal')
  assert.equal(prepared.restartScoped, false)
  assert.ok(prepared.preparationId)
  assert.equal((await api.control.cancel(a.id)).ok, true)
  await drain(k, api)
  assert.equal(k.ctx.goals.get(a).activation, 'disarmed')
  assert.deepEqual(api.recovery.status().pending, [])
  assert.equal(k.requests.length, 0)
  assert.deepEqual(exits, [])
})

test('canceling new preparation preserves genuine recovery from an earlier boot', options, async t => {
  const { root, boot } = await fixture(t)
  const first = await boot({}, false)
  const waiting = await first.k.create('session-prior-recovery')
  first.k.ctx.goals.create(waiting, { objective: 'This goal belongs to the previous boot.', maxGoalRounds: 3 })
  await first.k.flush(waiting)
  await first.k.close()
  // Discover durable work without immediately running it, then exercise real control.
  const next = await boot({}, false)
  const recovery = createRecovery({ adapter: createNativeAdapter(next.k.ctx), store: createStore(join(root, 'recovery')),
    config: { retryMinMs: 100, retryMaxMs: 1000 }, log: silent })
  const { createControl } = await import('../lib/control.js')
  const adapter = createNativeAdapter(next.k.ctx)
  const control = createControl({ adapter, recovery, appExit: code => next.exits.push(code),
    config: { drainTimeoutMs: 1000, restartExitCode: 75 }, log: silent })
  await recovery.discover()
  const owner = await next.k.create('session-new-restart-owner')
  assert.equal((await control.request(owner.id, {})).ok, true)
  assert.equal((await control.cancel(owner.id)).ok, true)
  assert.equal(recovery.status().pending.filter(j => j.kind === 'goal').length, 1)
  await recovery.tick()
  assert.equal(next.k.ctx.goals.get(next.k.ctx.agents.get(waiting.id)).activation, 'armed')
  assert.deepEqual(next.exits, [])
  recovery.stop()
})
