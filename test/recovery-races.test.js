/**
 * Pure coordinator regressions: node --test test/recovery-races.test.js
 *
 * Fixture contract (NOT a native DSH or durability integration test):
 * - The store clones JSON on read/update; it performs no filesystem I/O.
 * - Facts/receipts are explicit snapshots, not a simulated native event fold.
 * - queue records input, marks it pending and the agent running. Tests explicitly
 *   admit/end turns; there is no agent loop, automatic goal driver, or event bus.
 * - flush is an immediate acknowledgement unless a test replaces it.
 * - Controller-only fixtures have no agents/maintenance ownership; their ledger
 *   and suspension flag expose stale request preparation/cleanup effects.
 * - Promise barriers and an injected clock replace sleeps, timers, and services.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createControl } from '../lib/control.js'
import { createRecovery } from '../lib/recovery.js'
import { candidates, eligible, failureCategory, interruptedByRestart, keyFor, messageIdFor, retryDelay, retryableEnd } from '../lib/recovery-policy.js'

const bounded = { timeout: 2000 }
const config = {
  retryMinMs: 100, retryMaxMs: 400, drainTimeoutMs: 1000,
  restartWindowMs: 60_000, restartBurstLimit: 5, restartExitCode: 75,
}
const silent = { log() {}, error() {} }
const jsonClone = value => JSON.parse(JSON.stringify(value))
const barrier = () => Promise.withResolvers()
const temporary = () => ({ kind: 'error', error: { code: 'TEMPORARY_PROVIDER_ERROR', message: 'try later' } })

function memoryStore(jobs = []) {
  let state = {
    version: 2, jobs: Object.fromEntries(jobs.map(job => [job.key, jsonClone(job)])),
    recentRestarts: [], stopRequested: false,
  }
  return {
    read() { return jsonClone(state) },
    update(mutator) {
      const draft = jsonClone(state)
      mutator(draft)
      state = jsonClone(draft)
      return jsonClone(state)
    },
  }
}

function message(id = 'original-input') {
  return { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `Task ${id}` }] }
}

function savedJob({ kind = 'turn', sessionId = 'session-a', workId = 'turn:1:1', ...fields } = {}) {
  const key = keyFor(sessionId, workId)
  return {
    kind, sessionId, workId, key, messageId: messageIdFor(key, fields.attempt ?? 0),
    attempt: 0, failures: 0, retryAt: 0, status: 'pending', createdAt: 0,
    ...(kind === 'turn' ? { turn: 1, startSeq: 1, endSeq: null } : {}), ...fields,
  }
}
const inputJob = (input, seq, fields = {}) => savedJob({
  kind: 'input', workId: `input:${input.id}`, inputId: input.id, inputSeq: seq, ...fields,
})
const activeGoal = () => ({
  id: 'goal-a', revision: 1, objective: 'Finish the original goal', phase: 'active',
  activation: 'disarmed', roundsStarted: 0, maxGoalRounds: 10,
})
const goalJob = fields => savedJob({ kind: 'goal', workId: 'goal:goal-a', goalId: 'goal-a', ...fields })

function workTurn(turn = 1, startSeq = 1, reason = { kind: 'interrupted' }) {
  return { turn, startSeq, endSeq: reason ? startSeq + 5 : null, hasWork: true, ordinary: true, reason }
}

function fixture({ jobs = [], facts: overrides = {}, time = 100_000, running = false } = {}) {
  const sessionId = jobs[0]?.sessionId ?? overrides.header?.id ?? 'session-a'
  const facts = {
    header: { id: sessionId, origin: 'root' }, cursor: 30, inheritedEventCount: 0,
    goal: null, goalSeq: -1, goalOwned: false, latest: workTurn(), pending: [], receipts: new Map(),
    ...overrides,
  }
  const clock = { time, now: () => clock.time }
  const store = memoryStore(jobs)
  const calls = { queued: [], restored: [], resumed: [], injected: [], flushed: [] }
  const agent = {
    id: sessionId, status: running ? 'running' : 'idle',
    inject(input) { calls.injected.push(jsonClone(input)) },
  }
  const adapter = {
    async list() { return [sessionId] },
    live() { return [agent] },
    all() { return [agent] },
    snapshot() { return structuredClone(facts) },
    async inspect(id) { assert.equal(id, sessionId); return structuredClone(facts) },
    async restore(id) { calls.restored.push(id); return agent },
    async flush(subject) { assert.equal(subject, agent); calls.flushed.push(subject.id) },
    goal() { return facts.goal ? structuredClone(facts.goal) : null },
    resumeGoal(_subject, goal) {
      calls.resumed.push(structuredClone(goal))
      facts.goal.activation = 'armed'
    },
    disarmGoal() { if (facts.goal) facts.goal.activation = 'disarmed' },
    queue(subject, input) {
      assert.equal(subject, agent)
      calls.queued.push(jsonClone(input))
      const old = facts.receipts.get(input.id)
      const seq = old?.seq ?? ++facts.cursor
      facts.pending = facts.pending.filter(entry => entry.message.id !== input.id)
      facts.pending.push({ message: jsonClone(input), seq })
      facts.receipts.set(input.id, { message: jsonClone(input), seq, state: 'pending' })
      agent.status = 'running'
    },
  }
  const recovery = createRecovery({ adapter, store, config, now: clock.now, log: silent })
  function admitAndEnd(input, reason, turn = 2) {
    const old = facts.receipts.get(input.id)
    const startSeq = ++facts.cursor
    facts.pending = facts.pending.filter(entry => entry.message.id !== input.id)
    facts.receipts.set(input.id, { message: jsonClone(input), seq: old?.seq ?? startSeq + 1, state: 'admitted', turn })
    facts.latest = workTurn(turn, startSeq, reason)
    facts.cursor = facts.latest.endSeq ?? startSeq + 2
    agent.status = reason ? 'idle' : 'running'
  }
  return { facts, clock, store, calls, agent, adapter, recovery, admitAndEnd }
}

function controllerFixture({ onRecord = async () => {}, onCheckpoint = async () => {} } = {}) {
  const store = memoryStore(), exits = [], calls = { records: [], checkpoints: [], beforeExit: 0 }
  let suspended = false
  const recovery = {
    suspend(value) { suspended = value },
    async recordRequest(owner, prompt, requestId) {
      const index = calls.records.length
      calls.records.push({ owner, prompt, requestId })
      await onRecord(index)
      const job = savedJob({ kind: 'request', sessionId: owner, workId: `request:${requestId}`, requestSeq: 0, prompt })
      store.update(draft => { draft.jobs[job.key] = job })
      return job.key
    },
    discardRequest(key) { if (key) store.update(draft => { delete draft.jobs[key] }) },
    async checkpoint(disposalExpected = false) {
      const index = calls.checkpoints.length
      calls.checkpoints.push(disposalExpected)
      await onCheckpoint(index)
    },
    beforeExit() { calls.beforeExit++ },
  }
  const control = createControl({ adapter: { all: () => [] }, recovery, config, now: () => 100_000,
    appExit: code => exits.push(code), log: silent })
  return { control, store, exits, calls, suspended: () => suspended }
}

for (const stage of ['record', 'checkpoint']) {
  test(`cancel while request ${stage} is pending cannot resurrect that request`, bounded, async t => {
    const entered = barrier(), release = barrier()
    t.after(() => release.resolve())
    const wait = async () => { entered.resolve(); await release.promise }
    const h = controllerFixture(stage === 'record' ? { onRecord: wait } : { onCheckpoint: wait })
    const requesting = h.control.request('owner-a', { continuePrompt: 'canceled prompt' })
    await entered.promise
    assert.equal((await h.control.cancel('owner-a')).ok, true)
    release.resolve()
    const result = await requesting
    assert.equal(result.ok, false, 'stale preparation must not report an accepted restart')
    assert.equal(h.control.status().pending, null)
    assert.deepEqual(h.store.read().jobs, {}, 'cancellation also retires a key created after cancel returned')
    assert.equal(h.suspended(), false)
    await h.control.check()
    assert.deepEqual(h.exits, [])
  })
}

test('a failed checkpoint withholds the exit and keeps the request cancellable', bounded, async () => {
  const h = controllerFixture({ onCheckpoint: async index => {
    if (index > 0) throw new Error('injected checkpoint failure')
  } })
  assert.equal((await h.control.request('owner-a', {})).ok, true)
  await h.control.check()
  assert.deepEqual(h.exits, [], 'no exit without durable state')
  assert.equal(h.control.status().pending?.owner, 'owner-a', 'the request stays visible')
  assert.equal(h.control.status().holding, 0, 'a withheld restart holds nothing')
  assert.equal((await h.control.cancel('owner-a')).ok, true, 'and it stays cancellable')
  assert.equal(h.suspended(), false)
})

for (const stage of ['record', 'checkpoint']) {
  for (const outcome of ['resolve', 'reject']) {
    test(`stale ${stage} ${outcome} cannot overwrite or unsuspend a replacement restart`, bounded, async t => {
      const entered = barrier(), release = barrier()
      t.after(() => release.resolve())
      const waitFirst = async index => { if (index === 0) { entered.resolve(); await release.promise } }
      const h = controllerFixture(stage === 'record' ? { onRecord: waitFirst } : { onCheckpoint: waitFirst })
      const first = h.control.request('owner-a', { continuePrompt: 'old private prompt' })
      await entered.promise
      assert.equal((await h.control.cancel('owner-a')).ok, true)
      const second = await h.control.request('owner-b', { continuePrompt: 'replacement prompt' })
      assert.equal(second.ok, true)
      if (outcome === 'reject') release.reject(new Error('late preparation failure'))
      else release.resolve()
      const stale = await first
      assert.equal(stale.ok, false)
      assert.equal(h.control.status().pending?.owner, 'owner-b')
      assert.equal(h.control.status().pending?.requestId, second.requestId)
      assert.equal(h.suspended(), true, 'old cleanup must not release the replacement suspension')
      const jobs = Object.values(h.store.read().jobs)
      assert.equal(jobs.length, 1)
      assert.equal(jobs[0].sessionId, 'owner-b')
      assert.equal(jobs[0].prompt, 'replacement prompt')
      await h.control.check()
      assert.deepEqual(h.exits, [75], 'replacement must remain ready and executable')
    })
  }
}

function blockStage(h, stage) {
  const entered = barrier(), release = barrier()
  if (stage === 'restore') {
    const restore = h.adapter.restore
    h.adapter.restore = async id => { entered.resolve(); await release.promise; return restore(id) }
  } else {
    const inspect = h.adapter.inspect
    let count = 0
    h.adapter.inspect = async id => {
      if (++count === (stage === 'first inspect' ? 1 : 2)) { entered.resolve(); await release.promise }
      return inspect(id)
    }
  }
  return { entered, release }
}

for (const stage of ['first inspect', 'restore', 'second inspect']) {
  test(`recovery.stop fences delivery after awaited ${stage}`, bounded, async t => {
    const job = savedJob(), h = fixture({ jobs: [job] })
    const { entered, release } = blockStage(h, stage)
    t.after(() => release.resolve())
    const ticking = h.recovery.tick()
    await entered.promise
    h.recovery.stop()
    release.resolve()
    await ticking
    assert.deepEqual(h.calls.queued, [])
    assert.deepEqual(h.calls.injected, [])
    assert.deepEqual(h.calls.resumed, [])
    assert.equal(h.store.read().jobs[job.key]?.messageId, job.messageId, 'fenced work remains durable for another boot')
  })
}

test('stopping during goal restore does not rearm execution afterward', bounded, async t => {
  const job = goalJob(), h = fixture({ jobs: [job], facts: { goal: activeGoal(), goalOwned: true, goalSeq: 20 } })
  const { entered, release } = blockStage(h, 'restore')
  t.after(() => release.resolve())
  const ticking = h.recovery.tick()
  await entered.promise
  h.recovery.stop()
  release.resolve()
  await ticking
  assert.deepEqual(h.calls.resumed, [])
  assert.equal(h.facts.goal.activation, 'disarmed')
  assert.ok(h.store.read().jobs[job.key])
})

test('suspension fences awaited work but a later explicit unsuspend can retry it', bounded, async t => {
  const job = savedJob(), h = fixture({ jobs: [job] })
  const { entered, release } = blockStage(h, 'second inspect')
  t.after(() => release.resolve())
  const ticking = h.recovery.tick()
  await entered.promise
  h.recovery.suspend(true)
  release.resolve()
  await ticking
  assert.deepEqual(h.calls.queued, [])
  assert.ok(h.store.read().jobs[job.key])
  h.recovery.suspend(false)
  await h.recovery.tick()
  assert.equal(h.calls.queued.length, 1)
})

test('discarding a request during inspection fences its stale delivery snapshot', bounded, async t => {
  const job = savedJob({ kind: 'request', workId: 'request:old-boot', requestSeq: 0, originInstance: 'previous-boot' })
  const h = fixture({ jobs: [job] }), { entered, release } = blockStage(h, 'second inspect')
  t.after(() => release.resolve())
  const ticking = h.recovery.tick()
  await entered.promise
  h.recovery.discardRequest(job.key)
  release.resolve()
  await ticking
  assert.deepEqual(h.calls.queued, [])
  assert.deepEqual(h.store.read().jobs, {})
})

const olderStops = [
  ['user cancellation', { kind: 'aborted', reason: { kind: 'user' } }],
  ['blocked result', { kind: 'blocked' }],
  ['token limit', { kind: 'max-tokens' }],
  ['quota failure', { kind: 'error', error: { code: 'insufficient_quota', message: 'old quota failure' } }],
  ['credential failure', { kind: 'error', error: { code: 'invalid_api_key', message: 'old credentials' } }],
]
for (const [label, reason] of olderStops) {
  test(`older ${label} does not block newer durable human input`, bounded, async () => {
    const input = message('new-human-input'), job = inputJob(input, 20)
    const h = fixture({ jobs: [job], facts: {
      latest: workTurn(1, 1, reason), pending: [{ seq: 20, message: input }],
      receipts: new Map([[input.id, { state: 'pending', seq: 20, message: input }]]),
    } })
    await h.recovery.tick()
    assert.deepEqual(h.calls.queued, [input], 'new request must not inherit an older task stop')
    assert.notEqual(h.store.read().jobs[job.key]?.status, 'blocked')
  })

  test(`older ${label} does not veto a newer original active goal`, bounded, async () => {
    const job = goalJob(), h = fixture({ jobs: [job], time: 9_000_000_000_000, facts: {
      latest: workTurn(1, 1, reason), goal: activeGoal(), goalOwned: true, goalSeq: 20,
    } })
    await h.recovery.tick()
    await h.recovery.tick()
    assert.equal(h.calls.resumed.length, 1, 'goal ownership/sequence, not unrelated failure or wall-clock age, governs recovery exactly once')
    assert.equal(h.calls.resumed[0].id, job.goalId)
    assert.deepEqual(h.calls.queued, [], 'use the goal driver rather than an ordinary continuation')
    assert.deepEqual(h.store.read().jobs, {}, 'successful restart recovery retires the goal job')
    h.adapter.disarmGoal(h.agent)
    h.clock.time += config.retryMaxMs
    await h.recovery.tick()
    assert.equal(h.calls.resumed.length, 1, 'a later native disarm must not trigger steady-state goal monitoring or rearm')
  })
}

test('input job follows its generated continuation receipt through interruption and completion', bounded, async () => {
  const input = message(), job = inputJob(input, 2, { status: 'delivered' })
  const recoveryInput = { ...message(job.messageId), source: { kind: 'plugin', plugin: 'dsh-keep-going', form: 'instructions' } }
  const h = fixture({ jobs: [job], running: true, facts: {
    latest: workTurn(2, 20, null), receipts: new Map([
      [input.id, { state: 'admitted', seq: 2, message: input, turn: 1 }],
      [job.messageId, { state: 'admitted', seq: 21, message: recoveryInput, turn: 2 }],
    ]),
  } })
  assert.equal(eligible(job, h.facts), true, 'the older original receipt must not override the current continuation')
  await h.recovery.discoverSession(h.agent.id)
  await h.recovery.tick()
  assert.deepEqual(Object.keys(h.store.read().jobs), [job.key])
  assert.equal(h.store.read().jobs[job.key].messageId, job.messageId)
  assert.deepEqual(h.calls.queued, [], 'an already-running continuation is not duplicated')
  h.admitAndEnd(recoveryInput, { kind: 'interrupted' }, 2)
  assert.equal(eligible(h.store.read().jobs[job.key], h.facts), true)
  await h.recovery.discoverSession(h.agent.id)
  await h.recovery.tick()
  const retained = h.store.read().jobs[job.key]
  assert.ok(retained, 'interruption must retain the same original input job/key')
  assert.equal(retained.kind, 'input')
  const completed = { ...recoveryInput, id: retained.messageId }
  h.admitAndEnd(completed, { kind: 'completed' }, 3)
  assert.equal(eligible(retained, h.facts), false)
  const deliveries = h.calls.queued.length
  await h.recovery.discoverSession(h.agent.id)
  await h.recovery.tick()
  assert.deepEqual(h.store.read().jobs, {})
  assert.equal(h.calls.queued.length, deliveries, 'settlement does not replay the original input')
})

for (const receiptState of ['admitted', 'canceled']) {
  test(`active goal cannot revive ${receiptState === 'admitted' ? 'completed' : 'user-canceled'} original input`, bounded, async () => {
    const input = message(), job = inputJob(input, 10, { status: 'delivered' })
    const h = fixture({ jobs: [job], facts: {
      goal: activeGoal(), goalOwned: true, goalSeq: 5, latest: workTurn(2, 20, { kind: 'completed' }),
      receipts: new Map([[input.id, { state: receiptState, seq: 10, message: input, turn: 2 }]]),
    } })
    assert.equal(eligible(job, h.facts), false)
    await h.recovery.tick()
    assert.deepEqual(h.calls.queued, [])
    assert.deepEqual(h.store.read().jobs, {})
  })
}

test('a genuine pending human input remains recoverable alongside an active goal', bounded, async () => {
  const input = message(), job = inputJob(input, 10)
  const h = fixture({ jobs: [job], facts: {
    goal: activeGoal(), goalOwned: true, goalSeq: 5, latest: workTurn(1, 1, { kind: 'completed' }),
    pending: [{ seq: 10, message: input }], receipts: new Map([[input.id, { state: 'pending', seq: 10, message: input }]]),
  } })
  assert.equal(eligible(job, h.facts), true)
  await h.recovery.tick()
  assert.deepEqual(h.calls.queued, [input])
})

function forkFacts() {
  const inherited = message('parent-inherited-input'), own = message('fork-own-input')
  return {
    header: { id: 'fork-a', origin: 'fork' }, inheritedEventCount: 100, cursor: 110, latest: null,
    pending: [{ seq: 50, message: inherited }, { seq: 110, message: own }],
    receipts: new Map([
      [inherited.id, { seq: 50, message: inherited, state: 'pending' }],
      [own.id, { seq: 110, message: own, state: 'pending' }],
    ]),
  }
}

test('fork discovery recovers only its own queued input, never copied parent inbox work', bounded, async () => {
  const h = fixture({ facts: forkFacts() })
  assert.deepEqual(candidates(h.facts).filter(job => job.kind === 'input').map(job => job.inputId), ['fork-own-input'])
  await h.recovery.discoverSession(h.agent.id)
  assert.deepEqual(Object.values(h.store.read().jobs).map(job => job.inputId), ['fork-own-input'])
})

for (const hasRecoveryReceipt of [false, true]) {
  test(`fork rejects an already-saved inherited input job${hasRecoveryReceipt ? ' even with a later recovery receipt' : ''}`, bounded, async () => {
    const facts = forkFacts(), original = facts.pending[0].message
    const job = inputJob(original, 50, { sessionId: 'fork-a' })
    if (hasRecoveryReceipt) facts.receipts.set(job.messageId, { state: 'pending', seq: 120, message: message(job.messageId) })
    const h = fixture({ jobs: [job], facts })
    assert.equal(eligible(job, h.facts), false, 'saved records cannot bypass original-work ownership')
    await h.recovery.tick()
    assert.deepEqual(h.calls.queued, [])
    assert.deepEqual(h.calls.restored, [], 'inherited work should not even cause cold restore')
    assert.deepEqual(h.store.read().jobs, {})
    const own = inputJob(facts.pending[1].message, 110, { sessionId: 'fork-a' })
    assert.equal(eligible(own, h.facts), true, 'the boundary must not reject the fork own user input')
  })
}

function pendingFixture() {
  const input = message('queued-before-restart')
  const h = fixture({ facts: { latest: null, pending: [{ seq: 20, message: input }],
    receipts: new Map([[input.id, { seq: 20, message: input, state: 'pending' }]]) } })
  return { ...h, input }
}

test('checkpoint(true) saves input but does not authorize future disposal cancellation replay', bounded, async () => {
  const h = pendingFixture()
  await h.recovery.checkpoint(true)
  const [job] = Object.values(h.store.read().jobs)
  assert.deepEqual(job.savedInput, h.input)
  assert.notEqual(job.disposalExpected, true, 'preparing a cancellable exit is not actual disposal')
  h.recovery.beforeExit()
  assert.equal(h.store.read().jobs[job.key].disposalExpected, true, 'final synchronous disposal capture still preserves pending input')
})

for (const failFlush of [false, true]) {
  test(`${failFlush ? 'failed' : 'successful'} preparatory checkpoint cannot turn later user cancellation into replay`, bounded, async () => {
    const h = pendingFixture()
    if (failFlush) {
      h.adapter.flush = async () => { throw new Error('injected checkpoint flush failure') }
      await assert.rejects(h.recovery.checkpoint(true), /injected checkpoint flush failure/)
    } else await h.recovery.checkpoint(true)
    // Explicit user removal occurs while no real disposal has begun. There is
    // deliberately no turn/end here: a held idle inbox may be canceled directly.
    const receipt = h.facts.receipts.get(h.input.id)
    h.facts.receipts.set(h.input.id, { ...receipt, state: 'canceled' })
    h.facts.pending = []
    h.adapter.flush = async () => {}
    h.recovery.observeEvent(h.agent, { type: 'agent/inbox/spliced' })
    await h.recovery.tick()
    assert.deepEqual(h.calls.queued, [])
    assert.deepEqual(h.store.read().jobs, {}, 'only an actual disposal checkpoint may authorize saved input replay')
  })
}

function failedDeliveryFixture({ retryAt = 100_000, reason = temporary() } = {}) {
  const job = savedJob({ status: 'delivered', retryAt })
  const delivered = { ...message(job.messageId), source: { kind: 'plugin', plugin: 'dsh-keep-going', form: 'instructions' } }
  const h = fixture({ jobs: [job], facts: {
    latest: workTurn(2, 20, reason),
    receipts: new Map([[job.messageId, { message: delivered, seq: 21, state: 'admitted', turn: 2 }]]),
  } })
  return { ...h, job, delivered }
}

function queueFailureFixture() {
  const job = savedJob({ status: 'pending', retryAt: 0 })
  const h = fixture({ jobs: [job], facts: { latest: workTurn(1, 1, { kind: 'interrupted' }) } })
  const working = h.adapter.queue.bind(h.adapter)
  h.adapter.queue = () => { throw new Error('temporary delivery failure') }
  return { ...h, job, working }
}

test('an admitted continuation that failed is blocked, never re-sent on a timer', bounded, async () => {
  const h = failedDeliveryFixture()
  await h.recovery.tick()
  const saved = h.store.read().jobs[h.job.key]
  assert.equal(saved.status, 'blocked')
  assert.match(saved.lastError, /Continuation failed/)
  assert.deepEqual(h.calls.queued, [], 'a visible failure must not be replayed automatically')
  await h.recovery.tick()
  assert.deepEqual(h.calls.queued, [], 'blocked work stays put on later ticks')
})

test('a quota-exhausted continuation is blocked with the provider message', bounded, async () => {
  const h = failedDeliveryFixture({ reason: { kind: 'error', error: {
    code: 'UNKNOWN', message: "403 You've reached your 5-hour usage limit.",
  } } })
  await h.recovery.tick()
  const saved = h.store.read().jobs[h.job.key]
  assert.equal(saved.status, 'blocked')
  assert.match(saved.lastError, /usage limit/)
  assert.deepEqual(h.calls.queued, [])
})

test('delivery failures back off and stop at the attempt cap', bounded, async () => {
  const h = queueFailureFixture()
  for (let attempt = 1; attempt <= 3; attempt++) {
    h.clock.time = Math.max(h.clock.time, h.store.read().jobs[h.job.key].retryAt)
    await h.recovery.tick()
    const saved = h.store.read().jobs[h.job.key]
    assert.ok(saved, 'the record is kept for diagnosis')
    assert.equal(saved.failures, attempt)
    if (attempt < 3) {
      assert.equal(saved.status, 'retrying')
      assert.ok(saved.retryAt > h.clock.time)
    } else {
      assert.equal(saved.status, 'blocked', 'the cap ends automatic retries')
      assert.match(saved.lastError, /Delivery failed 3 times/)
    }
  }
})

test('delivery-failure backoff and identity survive coordinator recreation', bounded, async () => {
  const h = queueFailureFixture()
  await h.recovery.tick()
  const saved = h.store.read().jobs[h.job.key]
  assert.equal(saved.status, 'retrying')
  assert.ok(saved.retryAt > h.clock.time)
  assert.ok(saved.failures >= 1)
  h.adapter.queue = h.working
  const again = createRecovery({ adapter: h.adapter, store: h.store, config, now: h.clock.now, log: silent })
  h.clock.time = saved.retryAt - 1
  await again.tick()
  assert.deepEqual(h.calls.queued, [])
  h.clock.time = saved.retryAt
  await again.tick()
  assert.equal(h.calls.queued.length, 1)
  assert.equal(h.calls.queued[0].id, saved.messageId, 'the delivery identity is stable across recreation')
  assert.deepEqual(Object.keys(h.store.read().jobs), [h.job.key])
})

test('a disposal without our own restart intent is never treated as recoverable', () => {
  const disposed = { kind: 'aborted', reason: { kind: 'disposed' } }
  assert.equal(retryableEnd(disposed, { disposalExpected: true }), true, 'our own recorded exit is recoverable')
  assert.equal(retryableEnd(disposed, { disposalExpected: false }), false, 'a manually stopped session is not')
  assert.equal(retryableEnd(disposed, {}), false)
  assert.equal(retryableEnd({ kind: 'aborted', reason: { kind: 'user' } }, { disposalExpected: true }), false)
  assert.equal(retryableEnd({ kind: 'aborted', reason: { kind: 'hook' } }, { disposalExpected: true }), false)
  assert.equal(retryableEnd({ kind: 'aborted', reason: { kind: 'legacy' } }, { disposalExpected: true }), false)
  assert.equal(retryableEnd({ kind: 'interrupted' }, {}), true, 'a crash closer is exactly what recovery is for')
})

test('quota exhaustion is recognised in English and Chinese provider messages', () => {
  const err = message => ({ kind: 'error', error: { code: 'UNKNOWN', message } })
  assert.equal(failureCategory(err("You've reached your 5-hour usage limit.")), 'quota')
  assert.equal(failureCategory(err('余额不足，请充值')), 'quota')
  assert.equal(failureCategory(err('402 Payment Required')), 'quota')
  assert.equal(failureCategory(err('insufficient balance')), 'quota')
  assert.equal(failureCategory(err('429 too many requests, retry later')), 'temporary')
})

test('a session stopped by the user is not recovered again', bounded, async () => {
  const job = savedJob({ status: 'delivered', retryAt: 0 })
  const delivered = message(job.messageId)
  const h = fixture({ jobs: [job], facts: {
    latest: workTurn(2, 20, { kind: 'aborted', reason: { kind: 'disposed' } }),
    receipts: new Map([[job.messageId, { message: delivered, seq: 21, state: 'admitted', turn: 2 }]]),
  } })
  await h.recovery.tick()
  const saved = h.store.read().jobs[job.key]
  assert.equal(saved.status, 'blocked')
  assert.match(saved.lastError, /Stopped outside a restart/)
  assert.deepEqual(h.calls.queued, [], 'a manual stop must never be re-sent')
  // And rediscovery must not create a fresh job for that same stopped turn.
  await h.recovery.discoverSession('session-a')
  assert.deepEqual(h.calls.queued, [])
})

test('a discovery pass does not resurrect an unfinished turn the user disposed', () => {
  const facts = {
    header: { id: 'session-stop', origin: 'root' }, inheritedEventCount: 0,
    goal: null, goalOwned: false, pending: [], receipts: new Map(),
    latest: workTurn(1, 1, { kind: 'aborted', reason: { kind: 'disposed' } }),
  }
  assert.deepEqual(candidates(facts), [])
})

test('only a restart interruption counts as recoverable work', () => {
  assert.equal(interruptedByRestart({ kind: 'interrupted' }), true, 'a dead process is what this plugin recovers')
  assert.equal(interruptedByRestart({ kind: 'aborted', reason: { kind: 'disposed' } }, { disposalExpected: true }), true)
  assert.equal(interruptedByRestart({ kind: 'aborted', reason: { kind: 'disposed' } }), false)
  for (const reason of [
    { kind: 'aborted', reason: { kind: 'user' } },
    { kind: 'aborted', reason: { kind: 'hook' } },
    { kind: 'blocked' },
    { kind: 'max-tokens' },
    { kind: 'error', error: { code: 'TEMPORARY_PROVIDER_ERROR', message: 'try later' } },
    null,
  ]) assert.equal(interruptedByRestart(reason), false, `${JSON.stringify(reason)} is not restart work`)
})

test('an open turn is recorded, so a crash before it ends is still recoverable', () => {
  const facts = {
    header: { id: 'session-live', origin: 'root' }, inheritedEventCount: 0, goal: null, goalOwned: false,
    pending: [], receipts: new Map(), latest: workTurn(4, 40, null),
  }
  const work = candidates(facts)
  assert.equal(work.length, 1)
  assert.equal(work[0].kind, 'turn')
  assert.equal(work[0].turn, 4)
})

test('a steady-state failure never becomes recovery work', () => {
  for (const reason of [
    { kind: 'aborted', reason: { kind: 'user' } },
    { kind: 'blocked' },
    { kind: 'error', error: { code: 'TEMPORARY_PROVIDER_ERROR', message: 'try later' } },
    { kind: 'error', error: { code: 'UNKNOWN', message: "403 You've reached your 5-hour usage limit." } },
  ]) {
    const facts = {
      header: { id: 'session-live', origin: 'root' }, inheritedEventCount: 0, goal: null, goalOwned: false,
      pending: [], receipts: new Map(), latest: workTurn(4, 40, reason),
    }
    assert.deepEqual(candidates(facts), [], `${reason.kind} must not create a job while the harness is up`)
  }
})

test('repeated restart interruptions stop at the attempt cap instead of looping', bounded, async () => {
  const job = savedJob({ status: 'delivered', retryAt: 0 })
  const attemptId = attempt => messageIdFor(job.key, attempt)
  const receiptFor = id => ({ message: message(id), seq: 21, state: 'admitted', turn: 2 })
  const h = fixture({ jobs: [job], facts: {
    latest: workTurn(2, 20, { kind: 'interrupted' }), receipts: new Map([[job.messageId, receiptFor(job.messageId)]]),
  } })
  // First restart interruption: one more continuation, under a new identity.
  await h.recovery.tick()
  assert.equal(h.calls.queued.length, 1)
  assert.equal(h.calls.queued[0].id, attemptId(1), 'the consumed attempt needs its own message id')
  // Second interruption, then the cap: three deliveries total, then a report.
  for (const attempt of [2, 3]) {
    h.admitAndEnd(message(attemptId(attempt - 1)), { kind: 'interrupted' }, 3)
    h.recovery.suspend(false)
    h.clock.time = h.store.read().jobs[job.key].retryAt
    await h.recovery.tick()
    if (attempt === 2) assert.equal(h.calls.queued.length, 2)
  }
  const saved = h.store.read().jobs[job.key]
  assert.equal(saved.status, 'blocked')
  assert.equal(saved.attempt, 3)
  assert.match(saved.lastError, /Continuation interrupted 3 times/)
  assert.equal(h.calls.queued.length, 2, 'no fourth delivery is attempted')
})

test('a delivered caller request settles instead of being replayed forever', bounded, async () => {
  const job = savedJob({ kind: 'request', workId: 'request:req-1', requestSeq: 1, status: 'delivered', prompt: 'PRIVATE' })
  const delivered = message(job.messageId)
  const h = fixture({ jobs: [job], facts: {
    latest: workTurn(2, 20, { kind: 'completed' }),
    receipts: new Map([[job.messageId, { message: delivered, seq: 21, state: 'admitted', turn: 2 }]]),
  } })
  await h.recovery.discoverSession(job.sessionId)
  await h.recovery.tick()
  assert.deepEqual(h.store.read().jobs, {}, 'a finished caller request must be removed, not re-sent')
  assert.deepEqual(h.calls.queued, [])
})

test('a caller request whose continuation failed is blocked, never re-sent', bounded, async () => {
  const job = savedJob({ kind: 'request', workId: 'request:req-2', requestSeq: 1, status: 'delivered', prompt: 'PRIVATE' })
  const delivered = message(job.messageId)
  const h = fixture({ jobs: [job], facts: {
    latest: workTurn(2, 20, { kind: 'error', error: { code: 'UNKNOWN', message: "You've reached your 5-hour usage limit." } }),
    receipts: new Map([[job.messageId, { message: delivered, seq: 21, state: 'admitted', turn: 2 }]]),
  } })
  await h.recovery.tick()
  assert.equal(h.store.read().jobs[job.key].status, 'blocked')
  assert.deepEqual(h.calls.queued, [])
})

test('a record made during normal operation is dropped, never turned into work', bounded, async () => {
  const job = savedJob({ restartScoped: false })
  const h = fixture({ jobs: [job], facts: { latest: workTurn(1, 1, temporary()) } })
  await h.recovery.tick()
  assert.deepEqual(h.store.read().jobs, {}, 'the record is redundant with the durable log: it is dropped')
  assert.deepEqual(h.calls.queued, [])
})

test('a record made during normal operation never nudges a queued human message', bounded, async () => {
  const input = message('queued-human-message'), job = inputJob(input, 20, { restartScoped: false })
  const h = fixture({ jobs: [job], facts: {
    latest: workTurn(1, 1, { kind: 'completed' }), pending: [{ seq: 20, message: input }],
    receipts: new Map([[input.id, { state: 'pending', seq: 20, message: input }]]),
  } })
  await h.recovery.tick()
  assert.deepEqual(h.calls.queued, [], 'a live conversation is never steered or re-queued')
  assert.deepEqual(h.calls.injected, [])
  assert.deepEqual(h.store.read().jobs, {})
})

test('a record made during normal operation never continues an open turn', bounded, async () => {
  const job = savedJob({ restartScoped: false })
  const h = fixture({ jobs: [job], facts: { latest: workTurn(1, 1, null) } })
  await h.recovery.tick()
  assert.deepEqual(h.calls.queued, [], 'an open turn is left to DSH itself')
  assert.deepEqual(h.store.read().jobs, {})
})

test('a record made during normal operation never re-arms an active goal', bounded, async () => {
  const job = goalJob({ restartScoped: false })
  const h = fixture({ jobs: [job], facts: { goal: activeGoal(), goalOwned: true, goalSeq: 20, latest: workTurn(1, 1, temporary()) } })
  await h.recovery.tick()
  await h.recovery.tick()
  assert.deepEqual(h.calls.resumed, [], 'goal execution is never restarted outside restart recovery')
  assert.deepEqual(h.calls.queued, [])
  assert.deepEqual(h.store.read().jobs, {})
})

test('a crash upgrade claims a provisional record before it can be delivered', bounded, async () => {
  // The real boot sequence: discover() runs with restart scope before any tick,
  // so work left by a crash becomes restart work and is then recovered once.
  const job = savedJob({ restartScoped: false })
  const h = fixture({ jobs: [job], facts: { latest: workTurn(1, 1, { kind: 'interrupted' }) } })
  await h.recovery.discover()
  assert.equal(h.store.read().jobs[job.key]?.restartScoped, true, 'the boot scan claims the record')
  await h.recovery.tick()
  assert.equal(h.calls.queued.length, 1, 'the interrupted turn is continued exactly once')
  assert.equal(h.store.read().jobs[job.key].status, 'delivered')
})

test('a legacy record without a scope flag keeps restart semantics', bounded, async () => {
  const job = savedJob() // written by an older version, which had no scope flag
  const h = fixture({ jobs: [job], facts: { latest: workTurn(1, 1, { kind: 'interrupted' }) } })
  await h.recovery.tick()
  assert.equal(h.calls.queued.length, 1)
  assert.equal(h.store.read().jobs[job.key].status, 'delivered')
})

test('an exit claims work recorded during normal operation', bounded, async () => {
  const job = savedJob()
  const h = fixture({ jobs: [job], running: true, facts: { latest: workTurn(1, 1, null) } })
  assert.equal(h.store.read().jobs[job.key].restartScoped, undefined)
  h.recovery.beforeExit()
  assert.equal(h.store.read().jobs[job.key].restartScoped, true, 'the restart now owns this record')
})

for (const [label, latest] of [
  ['a newer completed turn', workTurn(4, 40, { kind: 'completed' })],
  ['a newer interrupted turn', workTurn(4, 40, { kind: 'interrupted' })],
]) {
  test(`an admitted receipt for an older turn is retired, not replayed (${label})`, bounded, async () => {
    const job = savedJob({ status: 'delivered' })
    const delivered = message(job.messageId)
    const h = fixture({ jobs: [job], facts: {
      latest, receipts: new Map([[job.messageId, { message: delivered, seq: 21, state: 'admitted', turn: 2 }]]),
    } })
    await h.recovery.tick()
    await h.recovery.tick()
    assert.deepEqual(h.calls.queued, [], 'the old delivery is never replayed on a timer')
    assert.deepEqual(h.store.read().jobs, {}, 'the settled record is retired')
  })
}
