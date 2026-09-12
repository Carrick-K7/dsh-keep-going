/**
 * Real-runtime smoke tests. No live DSH state or process is touched.
 * Use local test dependencies, or select an installed resolver explicitly:
 * DSH_NATIVE_TEST_RESOLVE_FROM=/opt/deepseek-harness/node_modules/.pnpm/fixture.cjs \
 *   node --test test/native-kernel.test.js
 * The resolver anchor need not exist; no file is created at that path.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createModuleLoader, createNativeKernel, NATIVE_PACKAGES, waitForAbort } from './native-kernel.mjs'

const resolver = process.env.DSH_NATIVE_TEST_RESOLVE_FROM
const loadModule = createModuleLoader(resolver ?? new URL('../package.json', import.meta.url))
let unavailable
try {
  await Promise.all(NATIVE_PACKAGES.map(loadModule))
} catch (error) {
  if (resolver) throw error
  unavailable = 'Native DSH test dependencies unavailable; set DSH_NATIVE_TEST_RESOLVE_FROM'
}
const options = { skip: unavailable, timeout: 15000 }

async function fixture(t, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), 'keep-going-native-'))
  const kernels = []
  t.after(async () => {
    try {
      for (const kernel of kernels.toReversed()) await kernel.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  const boot = async (overrides = {}) => {
    const kernel = await createNativeKernel({ root, loadModule, ...extra, ...overrides })
    kernels.push(kernel)
    return kernel
  }
  return { root, boot }
}

async function turn(kernel, agent, text) {
  agent.followup(kernel.message(text))
  await agent.whenIdle()
  await kernel.flush(agent)
}

test('native kernel persists two turns and cold-restores without a browser', options, async (t) => {
  const { boot } = await fixture(t, {
    response: (_request, { index }) => `native-answer-${index + 1}`,
  })
  const one = await boot()
  const agent = await one.create('session-native-two-turns')
  await turn(one, agent, 'first task')
  await turn(one, agent, 'second task')
  assert.deepEqual(one.outputs.map((output) => output.text), ['native-answer-1', 'native-answer-2'])
  assert.equal(one.foldConsumedWork(agent.session.ownEvents()).end.data.reason.kind, 'completed')
  assert.equal(one.errors.length, 0)
  await one.close()

  const two = await boot()
  assert.equal(two.ctx.agents.list().length, 0)
  const rows = await two.ctx.sessionQuery.listSessions()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].header.id, agent.id)
  assert.equal(rows[0].header.cwd, two.cwd)
  assert.equal(rows[0].live, false)
  assert.equal(rows[0].persisted, true)
  const observation = await two.ctx.sessionQuery.observeSession(agent.id)
  try {
    assert.equal(observation.source, 'prepared')
    assert.equal(observation.projections.values.goal, null)
    assert.equal(observation.events.filter((event) => event.type === 'turn/end').length, 2)
  } finally {
    observation[Symbol.dispose]()
  }

  const [first, second] = await Promise.all([
    two.ctx.sessionController.resolveAgent(agent.id),
    two.ctx.sessionController.resolveAgent(agent.id),
  ])
  assert.ok(!('error' in first), first.error?.message)
  assert.equal(first.agent, second.agent)
  const restored = first.agent
  assert.equal(restored.status, 'idle')
  assert.equal(restored.session.snapshotEvents().filter((event) => event.type === 'assistant/message').length, 2)
  await turn(two, restored, 'third task')
  assert.equal(two.requests.length, 1)
  assert.equal(two.requests[0].messages.filter((message) => message.source.kind === 'user').length, 3)
  assert.equal(two.outputs.length, 1)
  assert.equal(two.errors.length, 0)
})

test('native goal-round-driver admits a real goal round', options, async (t) => {
  const { boot } = await fixture(t, {
    onRequest(_request, { ctx, agent }) {
      const goal = ctx.goals.get(agent)
      assert.equal(goal.roundsStarted, 1)
      ctx.goals.complete(agent, goal)
    },
  })
  const kernel = await boot()
  const agent = await kernel.create('session-native-goal')
  const ended = Promise.withResolvers()
  kernel.ctx.on('session/event', (session, event) => {
    if (session.id === agent.id && event.type === 'turn/end') ended.resolve()
  })
  kernel.ctx.goals.create(agent, { objective: 'Fixture objective', maxGoalRounds: 2 })
  await ended.promise
  await agent.whenIdle()
  await kernel.flush(agent)
  const folded = kernel.foldGoal(agent.session.snapshotEvents())
  assert.equal(folded.goal.phase, 'complete')
  assert.equal(folded.roundsStarted, 1)
  assert.equal(kernel.requests.length, 1)
  assert.ok(kernel.requests[0].messages.some((message) => message.source.kind === 'goal' && message.source.round === 1))
  assert.equal(kernel.outputs[0].text, 'fixture-ok')
})

test('native cancellation persists explicit user intent', options, async (t) => {
  const entered = Promise.withResolvers()
  const { boot } = await fixture(t, {
    async onRequest(request) {
      entered.resolve()
      await waitForAbort(request.signal)
    },
  })
  const kernel = await boot()
  const agent = await kernel.create('session-native-cancel')
  agent.followup(kernel.message('interrupt this task'))
  await entered.promise
  agent.cancel({ kind: 'user' }, { keepInbox: true })
  await agent.whenIdle()
  await kernel.flush(agent)
  assert.deepEqual(kernel.foldConsumedWork(agent.session.ownEvents()).end.data.reason, {
    kind: 'aborted', reason: { kind: 'user' },
  })
  assert.equal(kernel.outputs.length, 0)
})

test('maintenance acquired on idle retains later inbox input until release', options, async (t) => {
  const { boot } = await fixture(t)
  const kernel = await boot()
  const agent = await kernel.create('session-native-maintenance')
  const release = Promise.withResolvers()
  let hold
  let captured = false
  const off = kernel.ctx.on('agent/status', ({ agent: subject, status }) => {
    if (subject !== agent || status !== 'idle' || captured) return
    captured = true
    hold = agent.runMaintenance(async (signal) => {
      if (signal.aborted) throw signal.reason
      await new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
        release.promise.then(resolve).finally(() => signal.removeEventListener('abort', abort))
      })
    })
    // Attach rejection handling immediately; cleanup may cancel the held task.
    hold.catch(() => {})
  })
  t.after(() => { off(); release.resolve() })
  agent.followup(kernel.message('first turn'))
  // Waiting for whenIdle here would wait for our own maintenance gate too.
  await new Promise((resolve) => {
    const stop = kernel.ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { stop(); resolve() }
    })
  })
  assert.equal(captured, true)
  const queued = kernel.message('queued while held', { id: 'msg-native-held' })
  agent.followup(queued)
  assert.equal(agent.status, 'idle')
  assert.equal(agent.inbox.nextTurn[0].id, queued.id)
  assert.equal(kernel.requests.length, 1)
  await kernel.flush(agent)
  release.resolve()
  await hold
  await agent.whenIdle()
  await kernel.flush(agent)
  assert.equal(kernel.requests.length, 2)
  assert.equal(agent.inbox.nextTurn.length, 0)
  assert.equal(agent.session.snapshotEvents().filter((event) => event.type === 'user/message' && event.data.id === queued.id).length, 1)
})
