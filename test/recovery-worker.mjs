/**
 * IPC-only fixture process. The test parent owns every process and root directory.
 * Real native Session/AgentLoop logs back recovery. Routing is ONLY a persisted
 * chat/thread fixture callback, not Feishu transport or external-effect coverage.
 */
import fs from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { createNativeAdapter } from '../lib/native.js'
import { createRecovery } from '../lib/recovery.js'
import { createStore } from '../lib/store.js'
import { createModuleLoader, createNativeKernel, waitForAbort } from './native-kernel.mjs'

const [mode, root, encoded = '{}'] = process.argv.slice(2)
const settings = JSON.parse(encoded)
if (!process.send || !root || !isAbsolute(root)) throw new Error('Worker requires IPC and an explicit absolute fixture root')
const routeFile = join(root, 'fixture-routes.json')
const outputFile = join(root, 'fixture-output.jsonl')
const loadModule = createModuleLoader(process.env.DSH_NATIVE_TEST_RESOLVE_FROM ?? new URL('../package.json', import.meta.url))
let kernel, recovery, closing = false
const diagnostics = []
const routed = []
const routingErrors = []
const entered = new Map()

const send = (value) => new Promise((resolve, reject) => {
  if (!process.connected) return reject(new Error('Fixture parent disconnected'))
  process.send(value, (error) => error ? reject(error) : resolve())
})

async function close() {
  if (closing) return
  closing = true
  recovery?.stop()
  await kernel?.close()
}
process.on('message', (message) => {
  if (message?.type !== 'close') return
  void (async () => {
    await close()
    await send({ type: 'closed' })
    process.disconnect()
  })().catch((error) => { process.stderr.write(String(error)); process.exitCode = 1; process.disconnect?.() })
})
process.on('disconnect', () => {
  void close().catch((error) => { process.stderr.write(String(error)); process.exitCode = 1 })
})

function writeFixture(file, value) {
  const fd = fs.openSync(file, 'w', 0o600)
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd) }
  finally { fs.closeSync(fd) }
}
function textOf(message) {
  return message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
}
function makeManifest(single) {
  const specs = single ? [['ordinary-a', 'ordinary']] : [
    ['ordinary-a', 'ordinary'], ['ordinary-b', 'ordinary'],
    ['active-a', 'active'], ['active-b', 'active'],
    ['paused', 'paused'], ['complete', 'complete'], ['finished', 'finished'],
  ]
  return specs.map(([label, state], index) => ({
    id: `session-process-${label}`,
    state,
    recover: ['ordinary', 'active'].includes(state),
    instructions: `ORIGINAL_INSTRUCTIONS_${label.toUpperCase().replaceAll('-', '_')}: finish only this session's unique task.`,
    privatePrompt: `PRIVATE_CALLER_${label.toUpperCase().replaceAll('-', '_')}_ONLY_9d71f0`,
    route: { chatId: `fixture-chat-${index + 1}`, threadId: `fixture-thread-${index + 1}` },
  }))
}

async function main() {
  const manifest = mode === 'seed' ? makeManifest(settings.single) : JSON.parse(fs.readFileSync(routeFile, 'utf8')).manifest
  const mapping = Object.fromEntries(manifest.map((item) => [item.id, item.route]))
  if (mode === 'seed') writeFixture(routeFile, { fixture: true, manifest, mapping })
  for (const item of manifest.filter((item) => item.recover)) entered.set(item.id, Promise.withResolvers())

  kernel = await createNativeKernel({
    root: join(root, 'native'), loadModule,
    // Seed durable goal phase without the automatic driver racing the setup.
    // Every recovery process mounts the real driver and begins with zero Agents.
    goalRounds: mode !== 'seed',
    async onRequest(request, { ctx, agent }) {
      if (mode === 'seed' && entered.has(agent.id)) {
        entered.get(agent.id).resolve()
        await waitForAbort(request.signal)
      }
      if (mode !== 'seed') {
        const goal = ctx.goals.get(agent)
        if (goal?.phase === 'active') ctx.goals.complete(agent, { id: goal.id, revision: goal.revision })
      }
    },
    response: (request) => `${mode === 'seed' ? 'seed-finished' : 'recovered'}:${request.sessionId}`,
  })
  const bootLive = kernel.ctx.agents.list().length
  kernel.ctx.on('session/event', (session, event) => {
    if (event.type !== 'assistant/message') return
    try {
      if (!mapping[session.id]) throw new Error(`No fixture route for ${session.id}`)
      const output = {
        fixture: true, sessionId: session.id, seq: event.seq,
        messageId: event.data.message.id, route: mapping[session.id], text: textOf(event.data.message),
      }
      // This callback runs ONLY after a real native assistant/message commit.
      const fd = fs.openSync(outputFile, 'a', 0o600)
      try { fs.writeFileSync(fd, JSON.stringify(output) + '\n'); fs.fsyncSync(fd) }
      finally { fs.closeSync(fd) }
      routed.push(output)
    } catch (error) { routingErrors.push(String(error)) }
  })
  const store = createStore(join(root, 'recovery'))
  const native = createNativeAdapter(kernel.ctx)
  let failQueue = mode === 'fail-queue'
  let queueCalls = 0
  const adapter = {
    ...native,
    queue(agent, message) {
      queueCalls++
      if (failQueue) { failQueue = false; throw new Error('FIXTURE_TEMPORARY_QUEUE_FAILURE') }
      return native.queue(agent, message)
    },
  }
  let clock = Math.max(1_000_000, ...Object.values(store.read().jobs).map((job) => job.retryAt || 0)) + 100
  recovery = createRecovery({
    adapter, store, config: { retryMinMs: 10, retryMaxMs: 100 }, now: () => clock,
    log: { log: (message) => diagnostics.push(message), error: (message) => diagnostics.push(message) },
  })

  if (mode === 'seed') {
    for (const item of manifest) {
      const agent = await kernel.create(item.id)
      if (item.state === 'active') {
        kernel.ctx.goals.create(agent, { objective: item.instructions, maxGoalRounds: 3 })
      }
      agent.followup(kernel.message(item.instructions, { id: `original-input-${item.id}` }))
      if (item.recover) await entered.get(item.id).promise
      else await agent.whenIdle()
      if (['paused', 'complete'].includes(item.state)) {
        const goal = kernel.ctx.goals.create(agent, { objective: item.instructions, maxGoalRounds: 3 })
        if (item.state === 'paused') kernel.ctx.goals.pause(agent, goal)
        else kernel.ctx.goals.complete(agent, goal)
      }
      await kernel.flush(agent)
    }
    // Only one explicitly requesting caller gets its private context. Ordinary B
    // and all imported jobs must use native history + neutral CONTINUE instead.
    if (!settings.single) {
      const caller = manifest.find((item) => item.state === 'ordinary')
      await recovery.recordRequest(caller.id, caller.privatePrompt, 'fixture-request-original-caller')
    }
    for (const agent of kernel.ctx.agents.list()) await kernel.flush(agent)
    await send({
      type: 'ready', pid: process.pid, manifest, jobs: store.read().jobs,
      originInstance: recovery.status().instance,
      open: manifest.filter((item) => item.recover).map((item) => {
        const agent = kernel.ctx.agents.get(item.id)
        return { id: item.id, status: agent.status,
          endCount: agent.session.snapshotEvents().filter((event) => event.type === 'turn/end').length }
      }),
    })
    return // IPC remains open: only the parent kills this fixture process.
  }

  const jobsBefore = store.read().jobs
  await recovery.discover()
  const discoveredJobs = store.read().jobs
  if (mode === 'discover') {
    await send({ type: 'discovered', pid: process.pid, bootLive, liveAfter: kernel.ctx.agents.list().length,
      jobsBefore, jobs: discoveredJobs, requestCount: kernel.requests.length })
    return
  }
  if (mode === 'fail-queue') {
    await recovery.tick()
    await send({ type: 'failed-once', pid: process.pid, bootLive, queueCalls,
      jobs: store.read().jobs, requestCount: kernel.requests.length, outputCount: routed.length, diagnostics })
    return
  }
  if (mode !== 'recover') throw new Error(`Unknown fixture mode ${mode}`)

  let settled = false
  for (let round = 0; round < 40; round++) {
    clock += 100
    await recovery.tick()
    await new Promise((resolve) => setImmediate(resolve))
    for (const agent of kernel.ctx.agents.list()) { await agent.whenIdle(); await kernel.flush(agent) }
    await recovery.tick()
    const wanted = manifest.filter((item) => item.recover)
    if (!Object.keys(store.read().jobs).length && wanted.every((item) => routed.some((out) => out.sessionId === item.id))) {
      settled = true
      break
    }
  }
  const facts = {}
  for (const item of manifest) {
    const observation = await kernel.ctx.sessionQuery.observeSession(item.id)
    try {
      facts[item.id] = {
        header: observation.header,
        goal: kernel.foldGoal(observation.events).goal ?? null,
        users: observation.events.filter((event) => event.type === 'user/message').map((event) => ({
          id: event.data.id, source: event.data.source, text: textOf(event.data), seq: event.seq,
        })),
        reasons: observation.events.filter((event) => event.type === 'turn/end').map((event) => event.data.reason),
      }
    } finally { observation[Symbol.dispose]() }
  }
  await send({
    type: 'recovered', pid: process.pid, bootLive, settled, jobsBefore, discoveredJobs,
    jobs: store.read().jobs, queueCalls, instance: recovery.status().instance,
    liveIds: kernel.ctx.agents.list().map((agent) => agent.id), manifest, facts, routed, routingErrors, diagnostics,
    requests: kernel.requests.map((request) => ({ sessionId: request.sessionId,
      messages: request.messages.map((message) => ({ id: message.id, source: message.source, text: textOf(message) })) })),
    limits: ['Routing is a fixture, not Feishu delivery.', 'No tool/external side-effect exactly-once guarantee is tested.'],
  })
}

try { await main() }
catch (error) {
  process.exitCode = 1
  if (process.connected) await send({ type: 'fatal', error: error.stack || String(error), diagnostics }).catch(() => {})
  await close().catch(() => {})
  if (process.connected) process.disconnect()
}
