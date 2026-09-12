/**
 * Opt-in full shipped Web composition, not the native-kernel controller facade.
 * DSH_WEB_TEST_BIN=/opt/deepseek-harness/node_modules/@deepseek-ai/dsh/lib/bin.js \
 * DSH_NATIVE_TEST_RESOLVE_FROM=/opt/deepseek-harness/node_modules/.pnpm/fixture.cjs \
 *   node --test test/full-web-process.test.js
 */
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { CONTINUE } from '../lib/recovery-policy.js'

const bin = process.env.DSH_WEB_TEST_BIN
const resolver = process.env.DSH_NATIVE_TEST_RESOLVE_FROM
const fixtureUrl = new URL('./full-web-fixture.mjs', import.meta.url)
const resolveUrl = new URL('./resolve-native.mjs', import.meta.url)
const pluginPath = fileURLToPath(new URL('../lib/index.js', import.meta.url))

async function ownedProcesses(t) {
  await access(resolve(bin)) // An explicitly configured but missing CLI MUST fail.
  const root = await mkdtemp(join(tmpdir(), 'keep-going-full-web-'))
  const owned = new Set()
  const killOwned = () => {
    for (const item of owned) if (!item.exited) item.child.kill('SIGKILL')
  }
  process.on('exit', killOwned)
  t.signal.addEventListener('abort', killOwned, { once: true })
  t.after(async () => {
    killOwned()
    await Promise.all([...owned].map((item) => item.exit))
    process.off('exit', killOwned)
    t.signal.removeEventListener('abort', killOwned)
    await rm(root, { recursive: true, force: true })
  })
  await Promise.all(['home', 'os-home', 'config', 'data', 'tmp', 'workspace'].map((part) => mkdir(join(root, part))))
  const overlay = join(root, 'fixture-overlay.json')
  // JSON is valid YAML. All changes are fixture-owned overlays/profile files.
  await writeFile(overlay, JSON.stringify([
    ...['llm-deepseek', 'llm-pi-ai', 'session-title-llm', 'session-telemetry-otel'].map((id) => ({ id, disabled: true })),
    { id: 'agent-default-model', config: { provider: 'full-web-unused-default', model: 'deliberately-different-default' } },
    { insert: [
      { id: 'full-web-fixture', name: fileURLToPath(fixtureUrl) },
      { id: 'keep-going', name: pluginPath, inject: ['fullWebFixtureReady'], config: {
        stateDirectory: join(root, 'recovery'), scanIntervalMs: 1000, retryMinMs: 100, retryMaxMs: 1000,
      } },
    ] },
  ], null, 2))

  function spawn(mode) {
    const child = fork(resolve(bin), [
      '--profile', 'full-web-acceptance',
      ...(mode === 'seed' ? ['--from-default-profile', 'web'] : []),
      '--patch', overlay, '--host', '127.0.0.1', '--port', '0', '--no-open',
    ], {
      cwd: join(root, 'workspace'),
      execArgv: ['--import', resolveUrl.href, '--import', fixtureUrl.href],
      env: {
        PATH: process.env.PATH ?? '',
        HOME: join(root, 'os-home'), DSH_HOME: join(root, 'home'),
        XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), TMPDIR: join(root, 'tmp'),
        DSH_TELEMETRY_DISABLED: '1', DSH_TOOLS_MODE: 'native',
        DSH_FULL_WEB_TEST_ROOT: root, DSH_FULL_WEB_TEST_MODE: mode,
        ...(resolver ? { DSH_NATIVE_TEST_RESOLVE_FROM: resolver } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    const completion = Promise.withResolvers()
    const item = { child, exited: false, exit: completion.promise }
    owned.add(item)
    const messages = [], waiters = new Set()
    let log = '', failure
    const safeLog = () => log.replace(/([?&]token=)[^\s)&]+/g, '$1[fixture-token-redacted]')
    const append = (data) => { log = (log + data).slice(-22000) }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    const fail = (error) => {
      failure = error
      for (const waiter of [...waiters]) waiter.reject(error)
    }
    child.on('message', (message) => {
      messages.push(message)
      if (message.type === 'fatal') {
        fail(new Error(`Full-Web ${mode} fixture failed: ${message.error}\n${JSON.stringify({ outboundAttempts: message.outboundAttempts, jobs: message.jobs })}\n${safeLog()}`))
        return
      }
      for (const waiter of [...waiters]) if (waiter.type === message.type) waiter.resolve(message)
    })
    child.once('error', (error) => { item.exited = true; completion.resolve({ error: String(error) }); fail(error) })
    child.once('exit', (code, signal) => {
      item.exited = true
      completion.resolve({ code, signal })
      fail(new Error(`Full-Web ${mode} CLI exited: code=${code} signal=${signal}\n${safeLog()}`))
    })
    function wait(type) {
      const received = messages.find((message) => message.type === type)
      if (received) return Promise.resolve(received)
      if (failure) return Promise.reject(failure)
      return new Promise((resolve, reject) => {
        let timer
        const done = (fn, value) => { clearTimeout(timer); waiters.delete(waiter); fn(value) }
        const waiter = { type, resolve: (value) => done(resolve, value), reject: (error) => done(reject, error) }
        timer = setTimeout(() => waiter.reject(new Error(`Full-Web ${mode} timed out waiting for ${type}\n${safeLog()}`)), 20000)
        waiters.add(waiter)
      })
    }
    return {
      wait,
      async stop(signal) {
        if (!item.exited) child.kill(signal)
        let timer
        try {
          return await Promise.race([
            item.exit,
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Full-Web ${mode} did not exit after ${signal}\n${safeLog()}`)), 10000) }),
          ])
        } finally { clearTimeout(timer) }
      },
    }
  }
  return { root, spawn }
}

async function assertRealWeb({ origin, launchUrl }) {
  const url = new URL(origin)
  assert.equal(url.hostname, '127.0.0.1')
  assert.ok(Number(url.port) > 0)
  assert.notEqual(url.port, '3080', 'never access the parent live GUI')
  // Fetch static HTML only. No Web client code executes, opens a session,
  // connects a Remote stream, or triggers a browser-driven cold promotion.
  const anonymous = await fetch(origin, { signal: AbortSignal.timeout(5000), redirect: 'manual' })
  assert.equal(anonymous.status, 401, 'the shipped Web authentication fence is active')
  await anonymous.arrayBuffer()
  assert.equal(new URL(launchUrl).origin, origin)
  // Authenticate using ONLY this owned child's newly generated launch token;
  // no live home, credential file, user key, or external provider is consulted.
  const exchange = await fetch(launchUrl, { signal: AbortSignal.timeout(5000), redirect: 'manual' })
  assert.equal(exchange.status, 303)
  const cookie = exchange.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie)
  await exchange.arrayBuffer()
  const response = await fetch(origin, { headers: { cookie }, signal: AbortSignal.timeout(5000) })
  assert.equal(response.status, 200)
  assert.match(await response.text(), /__DSH_BOOT__/)
}

test('real Web CLI cold-restores ordinary and active-goal sessions through shipped SessionController', {
  skip: bin ? false : 'Set DSH_WEB_TEST_BIN to opt into full shipped CLI acceptance', timeout: 55000,
}, async (t) => {
  const { root, spawn } = await ownedProcesses(t)
  const first = spawn('seed')
  const seed = await first.wait('seed-ready')
  assert.equal(seed.controllerIsShipped, true)
  assert.equal(seed.bootLive, 0)
  assert.equal(seed.sessions.length, 2)
  assert.deepEqual(seed.manifest.map((item) => item.kind).sort(), ['goal', 'ordinary'])
  assert.ok(seed.sessions.every((session) => session.status === 'running' && session.turnEnds === 0))
  assert.equal(seed.requests.length, 2)
  assert.deepEqual(seed.outboundAttempts, [])
  await assertRealWeb(seed)
  assert.equal((await first.stop('SIGKILL')).signal, 'SIGKILL')

  const next = spawn('recover')
  const result = await next.wait('recovered')
  assert.equal(result.controllerIsShipped, true)
  assert.equal(result.bootLive, 0, 'no live agents or browser promotion before plugin recovery')
  assert.deepEqual(result.outboundAttempts, [])
  assert.deepEqual(result.errors, [])
  assert.equal(result.pendingCount, 0)
  assert.equal(result.storageError, null)
  assert.deepEqual(result.requests.map((request) => request.sessionId).sort(), seed.manifest.map((item) => item.id).sort())
  assert.deepEqual(result.outputs.map((output) => output.sessionId).sort(), seed.manifest.map((item) => item.id).sort())
  assert.deepEqual([...result.starts].sort((a, b) => a.id.localeCompare(b.id)),
    seed.manifest.map((item) => ({ id: item.id, source: 'resume' })).sort((a, b) => a.id.localeCompare(b.id)))
  for (const item of seed.manifest) {
    const request = result.requests.find((entry) => entry.sessionId === item.id)
    assert.equal(request.provider, item.provider)
    assert.equal(request.model, item.model)
    assert.notEqual(request.provider, result.defaults.provider)
    assert.notEqual(request.model, result.defaults.model)
    assert.ok(request.messages.some((message) => message.text.includes(item.original)))
    for (const other of seed.manifest.filter((entry) => entry.id !== item.id)) {
      assert.ok(!request.messages.some((message) => message.text.includes(other.original)), 'original histories stay isolated')
    }
    const session = result.sessions.find((entry) => entry.id === item.id)
    assert.equal(session.header.cwd, join(root, 'workspace'))
    assert.equal(session.header.agentPreset, seed.sessions.find((entry) => entry.id === item.id).header.agentPreset)
    assert.equal(session.requestConfig.provider, item.provider)
    assert.equal(session.requestConfig.model, item.model)
    assert.equal(session.status, 'idle')
    assert.ok(session.reasons.some((reason) => reason.kind === 'interrupted'))
    assert.equal(result.outputs.find((output) => output.sessionId === item.id).text, `FULL_WEB_RECOVERED:${item.id}`)
    if (item.kind === 'goal') {
      assert.equal(session.goal.id, seed.sessions.find((entry) => entry.id === item.id).goal.id)
      assert.equal(session.goal.phase, 'complete')
      assert.equal(session.goal.roundsStarted, 1)
      assert.ok(request.messages.some((message) => message.source.kind === 'goal' && message.source.round === 1))
    } else assert.ok(request.messages.some((message) => message.source.kind === 'plugin' && message.text === CONTINUE))
  }
  await assertRealWeb(result)
  assert.equal((await next.stop('SIGTERM')).code, 0)
})
