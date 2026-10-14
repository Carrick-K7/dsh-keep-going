// Isolated DSH 0.2 config contract test. No native kernel, user config, disk
// store, restart, or SettingsForms constructor (which imports settings.yaml).
// Run with DSH_NATIVE_TEST_RESOLVE_FROM pointing at a 0.2 dependency anchor.
import assert from 'node:assert/strict'
import { createRequire, registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import test from 'node:test'

const require = createRequire(process.env.DSH_NATIVE_TEST_RESOLVE_FROM ?? new URL('../package.json', import.meta.url))
const entryURL = new URL('../lib/index.js', import.meta.url).href
const stubs = {
  './store.js': `export const createStore = directory => ({ directory, read() {} })`,
  './native.js': `export const createNativeAdapter = () => ({})`,
  './recovery.js': `export const createRecovery = options => ({
    ...options, discover: async () => {}, active: () => false,
    status: () => ({ pending: [] }), stop() {}, beforeExit() {},
  })`,
  './control.js': `export const createControl = options => ({
    ...options, check: async () => {}, dispose: async () => {},
    status: () => ({ pending: null }),
  })`,
}
let resolving = false
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL === entryURL && Object.hasOwn(stubs, specifier)) {
    return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true }
  }
  if (!resolving && specifier.startsWith('@deepseek-ai/')) {
    resolving = true
    try { return { url: pathToFileURL(require.resolve(specifier)).href, shortCircuit: true } }
    finally { resolving = false }
  }
  return next(specifier, context)
} })
const plugin = await import(entryURL)
const { Entry } = await import('@deepseek-ai/cordis-plugin-loader')
const { SettingsForms } = await import('@deepseek-ai/dsh-settings')
hooks.deregister()

async function mount(t, raw = {}) {
  const effects = []
  let api
  const ctx = {
    // Accessing either removed integration point must fail, not silently pass.
    get settings() { throw new Error('must not access settings.installSection') },
    inject() { throw new Error('must not install a legacy settings section') },
    on() {}, get() {},
    effect(callback) { const dispose = callback(); if (typeof dispose === 'function') effects.push(dispose) },
    tools: { register: () => () => {} }, commands: { register: () => () => {} },
    provide(name, value) { if (name === 'keepGoing') api = value },
  }
  t.after(async () => { for (const dispose of effects.reverse()) await dispose() })
  plugin.apply(ctx, raw)
  await api.ready
  return api
}

// Real loader update and settings projection/write implementations, with only
// their external profile/context I/O replaced. Never instantiate SettingsForms:
// its constructor schedules legacy document migration on the actual filesystem.
function profile(raw, live) {
  const reloads = []
  const root = { fiber: {}, emit() {}, logger: { warn() {}, debug() {} } }
  const entry = Object.create(Entry.prototype)
  entry.ctx = Object.create(root)
  entry.parent = { ctx: root, tree: { ctx: root } }
  entry.options = { id: 'keep-going', name: 'dsh-keep-going', config: raw }
  entry.fiber = {
    uid: 1, state: 2, runtime: plugin, config: live,
    ctx: { emit() {}, waterfall(_fiber, _event, _raw, next) { return next() } },
  }
  entry._patchContext = changes => reloads.push(changes)
  const settings = Object.create(SettingsForms.prototype)
  settings.revisions = new Map()
  settings.presentations = new Map()
  settings.ownerContext = {
    emit() {},
    configEditor: {
      entries: () => [entry],
      configuration: () => [{ entry, inherited: {}, override: entry.options.config }],
      edit: async (target, change) => target.update({ config: change(target.options.config, {}) }),
    },
  }
  return { entry, settings, reloads }
}

const hot = {
  drainTimeoutMs: 2000, retryMinMs: 200, retryMaxMs: 4000,
  maxAttempts: 7, scanIntervalMs: 5000, restartExitCode: 76,
  restartBurstLimit: 8, restartWindowMs: 10000,
}

test('0.2 Config exposes all hot fields as refs, but never stateDirectory', () => {
  const live = plugin.Config({})
  assert.equal(live.stateDirectory, '')
  assert.notEqual(plugin.Config.dict.stateDirectory.meta.volatile, true)
  assert.equal(live.maxAttempts.get(), 3)
  for (const key of Object.keys(hot)) {
    assert.equal(plugin.Config.dict[key].meta.volatile, true, key)
    assert.equal(typeof live[key].get, 'function', key)
  }
  assert.throws(() => plugin.Config({ maxAttempts: 11 }))
})

test('direct plain configuration needs no settings service or installSection', async t => {
  const api = await mount(t, { stateDirectory: '/isolated/config-original', maxAttempts: 4 })
  assert.equal(api.recovery.config().maxAttempts, 4)
  assert.equal(api.control.config().restartExitCode, 75)
  assert.equal(api.recovery.store.directory, resolve('/isolated/config-original'))
})

test('real 0.2 settings and loader update refs in place; later reads use new values', async t => {
  const raw = { stateDirectory: '/isolated/config-original' }
  const live = plugin.Config(raw)
  const api = await mount(t, live)
  const { settings, reloads } = profile(raw, live)
  const [form] = settings.describe()
  assert.equal(form.ns, 'keep-going', 'namespace is the entry id, not the legacy constant')
  assert.equal(form.applies, 'live')
  assert.equal(Object.hasOwn(form.value, 'stateDirectory'), false)
  assert.equal(Object.hasOwn(form.schema.refs[form.schema.uid].dict, 'stateDirectory'), false)
  assert.equal(typeof SettingsForms.prototype.installSection, 'undefined')
  const before = api.recovery.config()
  const refs = Object.fromEntries(Object.keys(hot).map(key => [key, live[key]]))
  await settings.update('keep-going', hot, form.revision)
  assert.deepEqual(reloads, [], 'volatile-only changes do not remount')
  for (const [key, value] of Object.entries(hot)) {
    assert.equal(live[key], refs[key], `${key}: stable runtime ref`)
    assert.equal(api.recovery.config()[key], value, `${key}: recovery sees update`)
    assert.equal(api.control.config()[key], value, `${key}: control sees update`)
  }
  assert.equal(before.maxAttempts, 3, 'an earlier operation keeps its own plain snapshot')
  assert.equal(settings.describe()[0].value.maxAttempts, 7)
  await assert.rejects(settings.update('dsh-keep-going', { maxAttempts: 5 }), /No configurable plugin entry/)
})

test('stateDirectory cannot be hot edited; ordinary config requests reload and pins the old store', async t => {
  const raw = { stateDirectory: '/isolated/config-original' }
  const live = plugin.Config(raw)
  const api = await mount(t, live)
  const { settings, entry, reloads } = profile(raw, live)
  await assert.rejects(settings.update('keep-going', { stateDirectory: '/isolated/config-next' }), /not volatile/)
  await entry.update({ config: { ...raw, stateDirectory: '/isolated/config-next' } })
  assert.equal(reloads.length, 1, 'real loader chooses ordinary reload lifecycle')
  assert.ok(reloads[0].includes('config'))
  // Even accidental mutation by a direct caller cannot hot-swap the live store.
  live.stateDirectory = '/isolated/config-next'
  assert.equal(api.recovery.config().stateDirectory, raw.stateDirectory)
  assert.equal(api.recovery.store.directory, resolve(raw.stateDirectory))
  const next = await mount(t, plugin.Config(entry.options.config))
  assert.equal(next.recovery.store.directory, resolve('/isolated/config-next'))
})

test('retry bounds are validated initially and again on subsequent live reads', async t => {
  assert.throws(() => plugin.apply({}, { retryMinMs: 6000, retryMaxMs: 1000 }), /retryMaxMs/)
  const raw = { stateDirectory: '/isolated/config-original' }
  const live = plugin.Config(raw)
  const api = await mount(t, live)
  const { settings } = profile(raw, live)
  await settings.update('keep-going', { retryMinMs: 90000 })
  assert.throws(() => api.recovery.config(), /retryMaxMs/)
  await settings.update('keep-going', { retryMaxMs: 100000 })
  assert.equal(api.recovery.config().retryMinMs, 90000)
  assert.equal(api.recovery.config().retryMaxMs, 100000)
})
