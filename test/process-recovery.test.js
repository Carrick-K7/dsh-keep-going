/**
 * True process-death recovery against isolated native DSH state.
 * Run: DSH_NATIVE_TEST_RESOLVE_FROM=/opt/deepseek-harness/node_modules/.pnpm/fixture.cjs \
 *        node --test test/process-recovery.test.js
 * Workers preload resolve-native.mjs; only fork() handles owned by these tests
 * are killed. Chat/thread delivery is a fixture, NOT a Feishu integration test.
 */
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CONTINUE } from '../lib/recovery-policy.js'
import { createModuleLoader, NATIVE_PACKAGES } from './native-kernel.mjs'

const resolver = process.env.DSH_NATIVE_TEST_RESOLVE_FROM
const loadModule = createModuleLoader(resolver ?? new URL('../package.json', import.meta.url))
let unavailable
try { await Promise.all(NATIVE_PACKAGES.map(loadModule)) }
catch (error) {
  if (resolver) throw error
  unavailable = 'Native DSH dependencies unavailable; set DSH_NATIVE_TEST_RESOLVE_FROM'
}
const options = { skip: unavailable, timeout: 20000 }
const workerUrl = new URL('./recovery-worker.mjs', import.meta.url)
const preloadUrl = new URL('./resolve-native.mjs', import.meta.url)

async function processes(t) {
  const root = await mkdtemp(join(tmpdir(), 'keep-going-process-'))
  const owned = new Set()
  const killOwned = () => {
    for (const item of owned) if (!item.exited) item.child.kill('SIGKILL')
  }
  // Abort/timeouts, test failure, and normal parent exit all target ONLY our children.
  t.signal.addEventListener('abort', killOwned, { once: true })
  process.on('exit', killOwned)
  t.after(async () => {
    killOwned()
    await Promise.all([...owned].map((item) => item.exit))
    process.off('exit', killOwned)
    t.signal.removeEventListener('abort', killOwned)
    await rm(root, { recursive: true, force: true })
  })

  function spawn(mode, settings = {}) {
    const child = fork(workerUrl, [mode, root, JSON.stringify(settings)], {
      execArgv: ['--import', preloadUrl.href],
      env: {
        PATH: process.env.PATH ?? '',
        HOME: join(root, 'home'), DSH_HOME: join(root, 'home'),
        ...(resolver ? { DSH_NATIVE_TEST_RESOLVE_FROM: resolver } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    const ended = Promise.withResolvers()
    const item = { child, exited: false, exit: ended.promise }
    owned.add(item)
    const messages = []
    const waiters = new Set()
    let stderr = '', fatal
    child.stdout.on('data', () => {})
    child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-12000) })
    const fail = (error) => {
      fatal = error
      for (const waiter of [...waiters]) waiter.reject(error)
    }
    child.on('message', (message) => {
      messages.push(message)
      if (message?.type === 'fatal') {
        fail(new Error(`Fixture ${mode} failed: ${message.error}\n${message.diagnostics?.join('\n') ?? ''}`))
        return
      }
      for (const waiter of [...waiters]) if (waiter.type === message.type) waiter.resolve(message)
    })
    child.once('error', (error) => {
      item.exited = true
      ended.resolve({ error: String(error) })
      fail(error)
    })
    child.once('exit', (code, signal) => {
      item.exited = true
      ended.resolve({ code, signal })
      fail(new Error(`Fixture ${mode} exited before response: code=${code} signal=${signal}\n${stderr}`))
    })
    function wait(type) {
      const received = messages.find((message) => message.type === type)
      if (received) return Promise.resolve(received)
      if (fatal) return Promise.reject(fatal)
      return new Promise((resolve, reject) => {
        let timer
        const done = (fn, value) => { clearTimeout(timer); waiters.delete(waiter); fn(value) }
        const waiter = { type, resolve: (value) => done(resolve, value), reject: (error) => done(reject, error) }
        timer = setTimeout(() => waiter.reject(new Error(`Fixture ${mode} timed out waiting for ${type}\n${stderr}`)), 10000)
        waiters.add(waiter)
      })
    }
    return {
      wait,
      async kill() {
        if (!item.exited) child.kill('SIGKILL')
        return item.exit
      },
      async close() {
        const closed = wait('closed')
        child.send({ type: 'close' })
        await closed
        return item.exit
      },
    }
  }
  return { root, spawn }
}

function assertSettled(result, wanted) {
  assert.equal(result.bootLive, 0, 'recovery starts without any browser-prepared Agent')
  assert.equal(result.settled, true, result.diagnostics.join('\n'))
  assert.deepEqual(result.jobs, {})
  assert.deepEqual(result.routingErrors, [])
  assert.deepEqual(result.requests.map((request) => request.sessionId).sort(), [...wanted].sort())
  assert.deepEqual(result.routed.map((output) => output.sessionId).sort(), [...wanted].sort())
  assert.match(result.limits.join(' '), /not Feishu/)
  assert.match(result.limits.join(' '), /No tool\/external side-effect exactly-once guarantee/)
}

async function crashSeed(spawn, single = false) {
  const first = spawn('seed', { single })
  const ready = await first.wait('ready')
  assert.ok(ready.open.length > 0)
  assert.ok(ready.open.every((entry) => entry.status === 'running' && entry.endCount === 0),
    'SIGKILL lands after native request/flush, before any native turn/end')
  assert.equal((await first.kill()).signal, 'SIGKILL')
  return ready
}

test('SIGKILL cold recovery restores original tasks/goals and isolates caller context and routes', options, async (t) => {
  const { spawn } = await processes(t)
  const seed = await crashSeed(spawn)
  const originalJobs = Object.values(seed.jobs)
  assert.equal(originalJobs.length, 1, 'only the explicit caller request was recorded before the crash')
  assert.equal(originalJobs[0].kind, 'request')
  assert.equal(originalJobs[0].originInstance, seed.originInstance)

  const next = spawn('recover')
  const recovered = await next.wait('recovered')
  const wanted = seed.manifest.filter((item) => item.recover).map((item) => item.id)
  assertSettled(recovered, wanted)
  assert.notEqual(recovered.instance, seed.originInstance)
  assert.deepEqual(recovered.liveIds.sort(), wanted.sort())
  for (const item of seed.manifest) {
    if (!item.recover) {
      assert.ok(!recovered.liveIds.includes(item.id), 'terminal tasks/goals remain cold')
      continue
    }
    const request = recovered.requests.find((request) => request.sessionId === item.id)
    const text = request.messages.map((message) => message.text).join('\n')
    assert.ok(text.includes(item.instructions), `original history missing for ${item.id}`)
    for (const other of seed.manifest.filter((candidate) => candidate.id !== item.id)) {
      assert.ok(!text.includes(other.privatePrompt), `private caller context leaked into ${item.id}`)
      assert.ok(!text.includes(other.instructions), `original task history leaked into ${item.id}`)
    }
    const output = recovered.routed.find((output) => output.sessionId === item.id)
    assert.deepEqual(output.route, item.route, 'actual assistant event uses original persisted route')
    assert.equal(output.text, `recovered:${item.id}`)
    assert.ok(recovered.facts[item.id].reasons.some((reason) => reason.kind === 'interrupted'))
    if (item.state === 'active') {
      assert.equal(recovered.facts[item.id].goal.phase, 'complete')
      assert.ok(request.messages.some((message) => message.source.kind === 'goal' && message.source.round === 1))
    }
  }
  const [a, b] = seed.manifest.filter((item) => item.state === 'ordinary')
  assert.notDeepEqual(a.route, b.route)
  const aRequest = recovered.requests.find((request) => request.sessionId === a.id)
  const bRequest = recovered.requests.find((request) => request.sessionId === b.id)
  assert.ok(aRequest.messages.some((message) => message.text === a.privatePrompt))
  assert.ok(bRequest.messages.some((message) => message.source.kind === 'plugin' && message.text === CONTINUE))
  assert.ok(!bRequest.messages.some((message) => message.text === b.privatePrompt))
  assert.equal(recovered.facts[a.id].users.filter((message) => message.id === originalJobs[0].messageId).length, 1)
  for (const state of ['paused', 'complete']) {
    const item = seed.manifest.find((candidate) => candidate.state === state)
    assert.equal(recovered.facts[item.id].goal.phase, state)
  }
  assert.equal((await next.close()).code, 0)
})

test('a second SIGKILL after durable discovery but before restore preserves stable recovery IDs', options, async (t) => {
  const { spawn } = await processes(t)
  const seed = await crashSeed(spawn, true)
  assert.deepEqual(seed.jobs, {})
  const middle = spawn('discover', { single: true })
  const discovered = await middle.wait('discovered')
  assert.equal(discovered.bootLive, 0)
  assert.equal(discovered.liveAfter, 0)
  assert.equal(discovered.requestCount, 0)
  const [pending] = Object.values(discovered.jobs)
  assert.ok(pending?.messageId)
  assert.equal(pending.status, 'pending')
  assert.equal((await middle.kill()).signal, 'SIGKILL')

  const last = spawn('recover', { single: true })
  const result = await last.wait('recovered')
  assert.deepEqual(result.jobsBefore, discovered.jobs)
  assertSettled(result, seed.manifest.map((item) => item.id))
  assert.equal(result.facts[pending.sessionId].users.filter((message) => message.id === pending.messageId).length, 1)
  assert.equal((await last.close()).code, 0)
})

test('transient native queue failure remains retryable across another process death', options, async (t) => {
  const { spawn } = await processes(t)
  const seed = await crashSeed(spawn, true)
  const failing = spawn('fail-queue', { single: true })
  const failure = await failing.wait('failed-once')
  assert.equal(failure.bootLive, 0)
  assert.equal(failure.queueCalls, 1)
  assert.equal(failure.requestCount, 0)
  assert.equal(failure.outputCount, 0)
  const [job] = Object.values(failure.jobs)
  assert.equal(job.status, 'retrying')
  assert.equal(job.failures, 1)
  assert.match(job.lastError, /FIXTURE_TEMPORARY_QUEUE_FAILURE/)
  assert.equal((await failing.kill()).signal, 'SIGKILL')

  const last = spawn('recover', { single: true })
  const result = await last.wait('recovered')
  assert.deepEqual(result.jobsBefore, failure.jobs)
  assertSettled(result, seed.manifest.map((item) => item.id))
  assert.equal(result.queueCalls, 1)
  assert.equal(result.facts[job.sessionId].users.filter((message) => message.id === job.messageId).length, 1)
  assert.equal((await last.close()).code, 0)
})
