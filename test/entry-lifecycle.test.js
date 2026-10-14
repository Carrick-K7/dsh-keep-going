// Entry-only lifecycle tests: actual index.js, deterministic promise barriers,
// no disk store, native sessions, process signals, sleeps, or real exit requests.
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const entryURL = new URL('../lib/index.js', import.meta.url).href
const slot = Symbol.for('keep-going.entry-lifecycle.test')
const stubs = {
  './store.js': 'export const createStore = () => ({ read() {} })',
  './native.js': 'export const createNativeAdapter = () => ({})',
  './recovery.js': `export const createRecovery = () => globalThis[Symbol.for('keep-going.entry-lifecycle.test')].recovery`,
  './control.js': `export const createControl = () => globalThis[Symbol.for('keep-going.entry-lifecycle.test')].control`,
}
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL === entryURL && Object.hasOwn(stubs, specifier)) {
    return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true }
  }
  return next(specifier, context)
} })
const { apply } = await import(entryURL)
hooks.deregister()

const barrier = () => Promise.withResolvers()
const settle = () => new Promise(resolve => setImmediate(resolve))

function fixture(t, { discovery = Promise.resolve(), checking, ticking } = {}) {
  const effects = [], events = new Map(), calls = { discover: 0, check: 0, tick: 0, stop: 0, refreshed: [] }
  const owned = new Set(['owned'])
  let api, timer, disposed = false
  const recovery = {
    async discover() { calls.discover++; await discovery },
    active: () => true,
    async tick() { calls.tick++; await ticking?.() },
    hasSession: id => owned.has(id),
    async refreshSession(id) { calls.refreshed.push(id) },
    stop() { calls.stop++ },
    beforeExit() { throw new Error('tests must not signal or exit') },
  }
  const control = {
    async check() { calls.check++; await checking?.() },
    status: () => ({ pending: null }),
    async dispose() {},
  }
  const ctx = {
    on(name, callback) { events.set(name, callback) },
    get() {},
    effect(callback) { const dispose = callback(); if (typeof dispose === 'function') effects.push(dispose) },
    tools: { register: () => () => {} }, commands: { register: () => () => {} },
    provide(name, value) { if (name === 'keepGoing') api = value },
  }
  const originalInterval = globalThis.setInterval
  // Capture the timer callback without scheduling anything. clearInterval safely
  // accepts this inert handle at disposal, so no global patch survives apply().
  globalThis.setInterval = callback => { timer = callback; return { unref() {} } }
  globalThis[slot] = { recovery, control }
  try { apply(ctx) }
  finally { globalThis.setInterval = originalInterval; delete globalThis[slot] }
  async function dispose() {
    if (disposed) return
    disposed = true
    for (const effect of effects.toReversed()) await effect()
  }
  t.after(dispose)
  return { api, timer: () => timer(), calls, events, control, recovery, dispose }
}

test('startup discovery gates timer/manual polls and ready awaits its first full pass', { timeout: 2000 }, async t => {
  const scan = barrier(), check = barrier(), tick = barrier()
  // Register release before fixture cleanup, including assertion-failure paths.
  t.after(() => { scan.resolve(); check.resolve(); tick.resolve() })
  const h = fixture(t, { discovery: scan.promise, checking: () => check.promise, ticking: () => tick.promise })
  let ready = false
  h.api.ready.then(() => { ready = true })
  h.timer()
  await h.api.poll()
  assert.equal(h.calls.discover, 1)
  assert.equal(h.calls.check, 0, 'no polling or provisional recovery can precede discovery')
  assert.equal(h.calls.tick, 0)
  assert.equal(ready, false)

  scan.resolve()
  await settle()
  assert.equal(h.calls.check, 1)
  const pass = h.api.poll()
  assert.equal(h.api.poll(), pass, 'manual callers share the actual in-flight promise')
  h.timer()
  assert.equal(h.calls.check, 1, 'timer joins that pass rather than running another')
  assert.equal(ready, false)
  check.resolve()
  await settle()
  assert.equal(h.calls.tick, 1)
  assert.equal(ready, false, 'ready must also await recovery.tick, not just control.check')
  tick.resolve()
  await h.api.ready
  await pass
  assert.equal(ready, true)
})

test('subsequent overlapping polls share one pass and return to idle after settlement', { timeout: 2000 }, async t => {
  const gate = barrier()
  t.after(() => gate.resolve())
  const h = fixture(t)
  await h.api.ready
  h.control.check = async () => { h.calls.check++; await gate.promise }
  const first = h.api.poll(), second = h.api.poll()
  assert.equal(first, second)
  h.timer()
  assert.equal(h.calls.check, 2, 'only startup plus one shared subsequent pass')
  gate.resolve()
  await first
  assert.equal(h.calls.tick, 2)
  await h.api.poll()
  assert.equal(h.calls.check, 3)
  assert.equal(h.calls.tick, 3)
  assert.equal(h.calls.discover, 1, 'polling never performs another discovery scan')
})

test('0.2 agent/created reconciles only resumed sessions with existing recovery', { timeout: 2000 }, async t => {
  const h = fixture(t)
  await h.api.ready
  assert.equal(h.events.has('agent/session-start'), false, 'removed event must not be registered')
  const created = h.events.get('agent/created')
  assert.equal(typeof created, 'function')
  created({ agent: { id: 'owned' }, source: 'startup' })
  created({ agent: { id: 'unowned' }, source: 'resume' })
  created({ agent: { id: 'owned' }, source: 'resume', signal: new AbortController().signal })
  await settle()
  assert.deepEqual(h.calls.refreshed, ['owned'])
  assert.equal(h.calls.discover, 1, 'opening sessions is not permission to discover new work')
})

test('disposal during startup fences late discovery from starting a recovery pass', { timeout: 2000 }, async t => {
  const scan = barrier()
  t.after(() => scan.resolve())
  const h = fixture(t, { discovery: scan.promise })
  const disposal = h.dispose()
  await settle() // Let earlier tool/command disposers reach the entry cleanup.
  assert.equal(h.calls.stop, 1)
  scan.resolve()
  await disposal
  await h.api.ready
  h.timer()
  await h.api.poll()
  assert.equal(h.calls.stop, 1)
  assert.equal(h.calls.check, 0)
  assert.equal(h.calls.tick, 0)
})
