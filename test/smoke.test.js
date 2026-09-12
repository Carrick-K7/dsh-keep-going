/**
 * Smoke test: boot the plugin against a minimal fake Cordis context and assert
 * the tool/command surface plus the marker round-trip. Uses a temporary
 * `DSH_HOME` so no real deployment state is touched.
 * Run with: node --test "test/*.test.js"
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { apply, Config, inject, name, SETTINGS_NAMESPACE } from '../lib/index.js'
import { markerPath, stateDir } from '../lib/state.js'

/** Minimal Cordis context: enough surface for this plugin's apply(). */
function fakeContext({ agents = [], onBoot = () => {}, goals = [] } = {}) {
  const tools = new Map()
  const commands = new Map()
  const listeners = new Map()
  const goalState = new Map(goals.map((goal) => [goal.sessionId, goal]))
  const rearmed = []
  const ctx = {
    agents: {
      list: () => agents,
      get: (id) => agents.find((agent) => agent.id === id),
      roots: () => agents.filter((agent) => agent.root === true),
    },
    tools: { register: (definition) => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
    commands: { register: (definition) => { commands.set(definition.name, definition) } },
    goals: {
      get: (agent) => goalState.get(agent.id),
      resume: (agent, view) => {
        if (view.phase !== 'active') throw new Error('not resumable: ' + view.phase)
        rearmed.push(view.id)
        return { ...view, revision: view.revision + 1 }
      },
    },
    effect: (fn) => { const dispose = fn(); return () => dispose?.() },
    on: (event, handler) => { listeners.set(event, handler); return () => listeners.delete(event) },
    inject: () => {},
    get: (service) => (service === 'appExit' ? onBoot : undefined),
  }
  return { ctx, tools, commands, listeners, rearmed }
}

/** A fresh `DSH_HOME` for one test. */
function useHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-going-'))
  process.env.DSH_HOME = home
  return home
}

/** An agent handle; `status` decides whether it counts as an in-flight turn. */
function makeAgent(id, status = 'running', root = true) {
  const agent = { id, status, root, steered: [] }
  agent.steer = (message) => agent.steered.push(message)
  return agent
}

test('apply exposes the documented surface', () => {
  useHome()
  const { ctx, tools, commands } = fakeContext()
  apply(ctx, { drainTimeoutMs: 1000, stuckAgentMs: 60000 })
  assert.equal(name, 'keep-going')
  assert.deepEqual([...inject], ['agents', 'tools', 'commands', 'goals'])
  assert.equal(SETTINGS_NAMESPACE, 'dsh-keep-going')
  assert.ok(typeof Config === 'function' || typeof Config === 'object')
  assert.deepEqual([...tools.keys()].sort(), ['cancel_harness_action', 'restart_harness', 'shutdown_harness'])
  assert.deepEqual([...commands.keys()].sort(), ['restart', 'shutdown'])
})

test('restart_harness refuses a mid-turn restart and honours force', async () => {
  useHome()
  const other = makeAgent('session-other', 'running')
  const { ctx, tools } = fakeContext({ agents: [other] })
  apply(ctx, { drainTimeoutMs: 60000, stuckAgentMs: 60000 })

  const refused = await tools.get('restart_harness').execute({}, { agent: { id: 'session-me' } })
  assert.equal(refused.ok, false)
  assert.deepEqual(refused.inFlight.map((entry) => entry.id), ['session-other'])
  assert.match(refused.message, /拒绝/)

  const forced = await tools.get('restart_harness').execute(
    { force: true, waitMs: 60000 },
    { agent: { id: 'session-me' } },
  )
  assert.equal(forced.ok, true)
})

test('restart_harness arms, then writes a marker and requests a clean exit', async () => {
  useHome()
  let exitCode = null
  const me = makeAgent('session-me', 'idle')
  const { ctx, tools } = fakeContext({ agents: [me], onBoot: (code) => { exitCode = code } })
  apply(ctx, { drainTimeoutMs: 1000, stuckAgentMs: 60000 })

  const result = await tools.get('restart_harness').execute(
    { continuePrompt: '接着干' },
    { agent: { id: 'session-me' } },
  )
  assert.equal(result.ok, true)

  await new Promise((resolve) => setTimeout(resolve, 1800))
  const marker = JSON.parse(fs.readFileSync(markerPath(process.env), 'utf8'))
  assert.equal(marker.wake, true)
  assert.deepEqual(marker.sessionIds, ['session-me'])
  assert.equal(marker.prompt, '接着干')
  assert.equal(exitCode, 0, 'clean exit goes through ctx.appExit')
})

test('cancel_harness_action restores the process while a turn is still in flight', async () => {
  useHome()
  const other = makeAgent('session-other', 'running')
  const me = makeAgent('session-me', 'idle')
  const { ctx, tools } = fakeContext({ agents: [other, me] })
  apply(ctx, { drainTimeoutMs: 60000, stuckAgentMs: 60000 })

  const armed = await tools.get('restart_harness').execute(
    { force: true, waitMs: 60000 },
    { agent: { id: 'session-me' } },
  )
  assert.equal(armed.ok, true)

  const denied = await tools.get('cancel_harness_action').execute({}, { agent: { id: 'session-other' } })
  assert.equal(denied.ok, false)
  assert.match(denied.message, /发起者/)

  const cancelled = await tools.get('cancel_harness_action').execute({}, { agent: { id: 'session-me' } })
  assert.equal(cancelled.ok, true)
  assert.match(cancelled.message, /已撤销/)

  const idle = await tools.get('cancel_harness_action').execute({}, { agent: { id: 'session-me' } })
  assert.equal(idle.ok, true)
  assert.match(idle.message, /没有待执行/)
})

test('shutdown_harness arms a restart-free exit named 关闭', async () => {
  useHome()
  const me = makeAgent('session-me', 'idle')
  const { ctx, tools } = fakeContext({ agents: [me], onBoot: () => {} })
  apply(ctx, { drainTimeoutMs: 60000, stuckAgentMs: 60000 })

  const shutdown = await tools.get('shutdown_harness').execute({}, { agent: { id: 'session-me' } })
  assert.equal(shutdown.ok, true)
  assert.match(shutdown.message, /关闭/)
})

test('the next boot steers the recorded session with the continue prompt', () => {
  useHome()
  fs.mkdirSync(stateDir(process.env), { recursive: true })
  fs.writeFileSync(markerPath(process.env), JSON.stringify({
    version: 1, action: 'restart', at: new Date().toISOString(), wake: true,
    owner: 'session-me', sessionIds: ['session-me'], exits: [], prompt: '继续未完成的工作',
  }))
  const me = makeAgent('session-me', 'idle')
  const { ctx } = fakeContext({ agents: [me] })
  apply(ctx, {})
  assert.equal(me.steered.length, 1)
  assert.equal(me.steered[0].content[0].text, '继续未完成的工作')
  assert.equal(me.steered[0].source.plugin, 'dsh-keep-going')
  assert.equal(fs.existsSync(markerPath(process.env)), false, 'marker is consumed once')
})

test('every interrupted session is woken, each with the right message', async () => {
  useHome()
  const me = makeAgent('session-me', 'idle')
  const busy = makeAgent('session-busy', 'running')
  const busy2 = makeAgent('session-busy-2', 'running')
  const idle = makeAgent('session-idle', 'idle')
  const first = fakeContext({ agents: [me, busy, busy2, idle], onBoot: () => {} })
  apply(first.ctx, { drainTimeoutMs: 1000, stuckAgentMs: 60000 })

  const armed = await first.tools.get('restart_harness').execute(
    { force: true, continuePrompt: '接着干我的活' },
    { agent: { id: 'session-me' } },
  )
  assert.equal(armed.ok, true)
  await new Promise((resolve) => setTimeout(resolve, 1800))

  const marker = JSON.parse(fs.readFileSync(markerPath(process.env), 'utf8'))
  assert.equal(marker.owner, 'session-me')
  assert.deepEqual(marker.sessionIds, ['session-me', 'session-busy', 'session-busy-2'],
    'the caller and every interrupted turn, never an idle session')

  // Phase 2: the caller gets its own instruction, the others a neutral notice.
  const mine = makeAgent('session-me', 'idle')
  const other = makeAgent('session-busy', 'running')
  const other2 = makeAgent('session-busy-2', 'running')
  const untouched = makeAgent('session-idle', 'idle')
  apply(fakeContext({ agents: [mine, other, other2, untouched] }).ctx, {})
  assert.equal(mine.steered[0].content[0].text, '接着干我的活')
  for (const agent of [other, other2]) {
    assert.equal(agent.steered.length, 1, agent.id + ' is woken')
    assert.doesNotMatch(agent.steered[0].content[0].text, /接着干我的活/,
      agent.id + ' must not receive the caller\'s instruction')
    assert.match(agent.steered[0].content[0].text, /重启/)
  }
  assert.equal(untouched.steered.length, 0, 'an idle session stays untouched')
})

test('a marker without wake targets boots quietly', () => {
  useHome()
  fs.mkdirSync(stateDir(process.env), { recursive: true })
  fs.writeFileSync(markerPath(process.env), JSON.stringify({
    version: 1, action: 'shutdown', at: new Date().toISOString(), wake: false, sessionIds: [], exits: [],
  }))
  const me = makeAgent('session-me', 'idle')
  const { ctx } = fakeContext({ agents: [me] })
  apply(ctx, {})
  assert.equal(me.steered.length, 0)
})

test('an unavailable optional service degrades the plugin instead of failing the boot', async () => {
  useHome()
  const me = makeAgent('session-me', 'idle')
  const built = fakeContext({ agents: [me], onBoot: () => {} })
  // Cordis throws when an undeclared service is read; the fake mirrors that so
  // a regression to "read ctx.commands without inject" fails here, not at boot.
  Object.defineProperty(built.ctx, 'commands', {
    get() { throw new Error('cannot get property "commands" without inject') },
  })
  apply(built.ctx, { drainTimeoutMs: 60000, stuckAgentMs: 60000 })
  assert.deepEqual([...built.tools.keys()].sort(), ['cancel_harness_action', 'restart_harness', 'shutdown_harness'])
  const armed = await built.tools.get('restart_harness').execute({ waitMs: 60000 }, { agent: { id: 'session-me' } })
  assert.equal(armed.ok, true)
})

test('the wake still runs when the tool surface cannot be registered', () => {
  useHome()
  fs.mkdirSync(stateDir(process.env), { recursive: true })
  fs.writeFileSync(markerPath(process.env), JSON.stringify({
    version: 1, action: 'restart', at: new Date().toISOString(), wake: true,
    owner: 'session-me', sessionIds: ['session-me'], exits: [], prompt: '接着干',
  }))
  const me = makeAgent('session-me', 'idle')
  const built = fakeContext({ agents: [me] })
  Object.defineProperty(built.ctx, 'tools', {
    get() { throw new Error('cannot get property "tools" without inject') },
  })
  apply(built.ctx, {})
  assert.equal(me.steered.length, 1, 'resume must not depend on the optional surfaces')
  assert.equal(me.steered[0].content[0].text, '接着干')
})

test('end to end: arm → marker + clean exit → next boot resumes the caller', async () => {
  useHome()
  const me = makeAgent('session-me', 'idle')
  const first = fakeContext({ agents: [me], onBoot: () => {} })
  apply(first.ctx, { drainTimeoutMs: 1000, stuckAgentMs: 60000 })
  const armed = await first.tools.get('restart_harness').execute(
    { continuePrompt: '续跑验证' },
    { agent: { id: 'session-me' } },
  )
  assert.equal(armed.ok, true)

  // Wait for the drain, the marker write and the clean-exit request.
  await new Promise((resolve) => setTimeout(resolve, 1800))
  assert.equal(fs.existsSync(markerPath(process.env)), true, 'phase 1 wrote the marker')

  // Phase 2: a new process boots with the same DSH_HOME — exactly what the
  // supervisor starts after the exit.
  const revived = makeAgent('session-me', 'idle')
  const second = fakeContext({ agents: [revived] })
  apply(second.ctx, {})
  assert.equal(revived.steered.length, 1, 'phase 2 woke the recorded session')
  assert.equal(revived.steered[0].content[0].text, '续跑验证')
  assert.equal(fs.existsSync(markerPath(process.env)), false, 'marker consumed')
})

test('a goal that was active before the restart is re-armed on start', () => {
  useHome()
  const agent = makeAgent('session-me', 'idle')
  const built = fakeContext({
    agents: [agent],
    goals: [{ id: 'goal-1', sessionId: 'session-me', phase: 'active', revision: 7 }],
  })
  apply(built.ctx, {})
  built.listeners.get('agent/session-start')({ agent, source: 'resume' })
  assert.deepEqual(built.rearmed, ['goal-1'], 'the active goal is brought back')
})

test('goals that were stopped on purpose are left alone', () => {
  useHome()
  for (const phase of ['paused', 'blocked', 'complete']) {
    const agent = makeAgent('session-' + phase, 'idle')
    const built = fakeContext({
      agents: [agent],
      goals: [{ id: 'goal-' + phase, sessionId: agent.id, phase, revision: 1 }],
    })
    apply(built.ctx, {})
    built.listeners.get('agent/session-start')({ agent, source: 'resume' })
    assert.deepEqual(built.rearmed, [], phase + ' must not be resumed')
  }
})

test('a session without a goal, or a goal service that throws, breaks nothing', () => {
  useHome()
  const noGoal = makeAgent('session-none', 'idle')
  const built = fakeContext({ agents: [noGoal] })
  apply(built.ctx, {})
  built.listeners.get('agent/session-start')({ agent: noGoal, source: 'resume' })
  assert.deepEqual(built.rearmed, [])

  const broken = makeAgent('session-broken', 'idle')
  const withBrokenGoals = fakeContext({ agents: [broken] })
  Object.defineProperty(withBrokenGoals.ctx, 'goals', {
    get() { throw new Error('cannot get property "goals" without inject') },
  })
  apply(withBrokenGoals.ctx, {})
  assert.deepEqual([...withBrokenGoals.tools.keys()].length, 3, 'the tool surface still registers')
})

test('a goal whose resume fails is reported and left as it was', () => {
  useHome()
  const agent = makeAgent('session-me', 'idle')
  const built = fakeContext({
    agents: [agent],
    goals: [{ id: 'goal-exhausted', sessionId: 'session-me', phase: 'active', revision: 3 }],
  })
  built.ctx.goals.resume = () => { throw new Error('exhausted goal rounds') }
  apply(built.ctx, {})
  built.listeners.get('agent/session-start')({ agent, source: 'resume' })
  assert.deepEqual(built.rearmed, [], 'a failed resume is not counted as re-armed')
})
