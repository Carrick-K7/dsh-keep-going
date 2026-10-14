/** dsh-keep-going: restore original tasks after a supervised process restart. */
import os from 'node:os'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'
import { createStore } from './store.js'
import { createNativeAdapter } from './native.js'
import { createRecovery } from './recovery.js'
import { createControl } from './control.js'

export const name = 'keep-going'
export const SETTINGS_NAMESPACE = 'dsh-keep-going'
export const inject = ['agents', 'tools', 'commands', 'sessions', 'sessionQuery', 'sessionController', 'goals', 'workspaceRegistry']
export const Config = z.object({
  // Ordinary config: changing the durable store requires a plugin reload.
  stateDirectory: z.string().default(''),
  drainTimeoutMs: z.number().min(1000).step(1).default(600000).volatile(),
  retryMinMs: z.number().min(100).step(1).default(1000).volatile(),
  retryMaxMs: z.number().min(1000).step(1).default(60000).volatile(),
  maxAttempts: z.number().min(1).max(10).step(1).default(3).volatile(),
  scanIntervalMs: z.number().min(1000).step(1).default(30000).volatile(),
  restartExitCode: z.number().min(1).max(255).step(1).default(75).volatile(),
  restartBurstLimit: z.number().min(1).step(1).default(5).volatile(),
  restartWindowMs: z.number().min(1000).step(1).default(60000).volatile(),
})
const output = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: value.message || JSON.stringify(value) }],
}

export function apply(ctx, raw = {}) {
  // DSH 0.2 discovers Config through the loader entry, not installSection.
  // Retain the runtime-owned refs: parsing them once would detach live updates.
  const hotKeys = Object.keys(Config.dict).filter(key => Config.dict[key].meta.volatile)
  const readConfig = (stateDirectory = raw.stateDirectory) => {
    const values = { ...raw, stateDirectory }
    for (const key of hotKeys) {
      const value = raw[key]
      values[key] = value && typeof value.get === 'function' ? value.get() : value
    }
    const current = Config(values) // Also supports plain values in direct/test calls.
    for (const key of hotKeys) current[key] = current[key].get()
    if (current.retryMaxMs < current.retryMinMs) throw new Error('retryMaxMs must be at least retryMinMs')
    return current
  }
  const initial = readConfig()
  const config = () => readConfig(initial.stateDirectory)
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const directory = initial.stateDirectory ? path.resolve(home, initial.stateDirectory) : path.join(home, 'dsh-keep-going')
  const store = createStore(directory)
  store.read() // Invalid state is an explicit error, never silently erased.
  const adapter = createNativeAdapter(ctx)
  const humanWaits = new Map()
  adapter.waitingForUser = agent => (humanWaits.get(agent.id) || 0) > 0
  ctx.on('user-questions/request', async (request, next) => {
    const id = request.agent?.id
    if (id) humanWaits.set(id, (humanWaits.get(id) || 0) + 1)
    try { return await next() }
    finally {
      if (id) { const left = (humanWaits.get(id) || 1) - 1; if (left) humanWaits.set(id, left); else humanWaits.delete(id) }
    }
  })
  const recovery = createRecovery({ adapter, store, config })
  const control = createControl({ adapter, recovery, config, appExit: ctx.get('appExit') })
  const tasks = new Set()
  let disposed = false, booting = true, polling = null
  const run = (promise) => {
    tasks.add(promise)
    promise.catch(error => console.error('[keep-going]', error.message)).finally(() => tasks.delete(promise))
    return promise
  }

  ctx.on('session/event', (session, event) => {
    const pending = control.status().pending
    // Ordinary activity cannot create recovery work. Existing restart work must
    // still observe replies and terminal events after the restart has finished.
    if (!pending && !recovery.hasSession(session.id)) return
    const agent = ctx.agents.get(session.id)
    if (agent && session.header.origin !== 'subagent') recovery.observeEvent(agent, event,
      { capture: !!pending, preparationId: pending?.requestId })
  })
  // No status listener takes locks: a scheduled restart must never hold a
  // conversation. Locks exist only inside control.check()'s handover window.
  ctx.on('agent/created', ({ agent, source }) => {
    // Opening a conversation is not authorization to discover more work.
    if (source === 'resume' && recovery.hasSession(agent.id)) run(recovery.refreshSession(agent.id))
  })
  const poll = () => {
    if (disposed || booting) return Promise.resolve()
    // All callers await the same in-flight pass; ready cannot finish early when
    // its first pass overlaps a timer, and no provisional record beats discovery.
    if (polling) return polling
    polling = (async () => {
      await control.check()
      // No periodic discovery: recovery runs once after a restart and then the
      // plugin goes dormant. tick() only continues due/failed work.
      if (recovery.active()) await recovery.tick()
    })().finally(() => { polling = null })
    return polling
  }

  // Observe signals BEFORE DSH's own shutdown listener. Never kill, re-raise,
  // or replace its shutdown. The hook only saves pending input synchronously.
  const noteExit = () => {
    try { recovery.beforeExit() }
    catch (error) { console.error('[keep-going] could not save recovery before external shutdown:', error.message) }
  }
  process.prependListener('SIGTERM', noteExit)
  process.prependListener('SIGINT', noteExit)
  const timer = setInterval(() => { run(poll()) }, 500)
  timer.unref()
  ctx.effect(() => async () => {
    process.removeListener('SIGTERM', noteExit); process.removeListener('SIGINT', noteExit)
    clearInterval(timer); disposed = true
    // Disposal itself does not turn an active goal into a paused goal.
    recovery.stop()
    await control.dispose()
    await Promise.allSettled([...tasks])
  })

  const request = (agent, args) => {
    if (!agent || agent.session.header.origin === 'subagent') {
      return { ok: false, message: '请由原始用户对话发起重启；子代理不能重启整个 DSH。' }
    }
    return control.request(agent.id, args)
  }
  const status = (agent) => {
    const state = recovery.status()
    return { ...control.status(), storageError: state.storageError, pendingCount: state.pending.length,
      tasks: state.pending.filter(j => j.sessionId === agent?.id).map(j => ({ kind: j.kind, status: j.status,
        waiting: j.waiting || [], lastError: j.lastError || null, retryAt: j.retryAt })) }
  }
  const register = definition => ctx.effect(() => ctx.tools.register({ ...definition, output }))
  register({
    name: 'restart_harness',
    description: '安排 DSH 正常重启。等待正在进行的任务并保存新消息，重启后自动恢复未完成任务和 active 目标。需要服务管理器在退出后重新启动 DSH。',
    parameters: { type: 'object', properties: {
      continuePrompt: { type: 'string', description: '只交给当前对话的重启后提示，绝不转发给其他对话。' },
      waitMs: { type: 'integer', minimum: 1000, description: '等待时限（毫秒）；不带 force 时到期仍会继续等，不会强行中断。' },
      force: { type: 'boolean', description: '明确允许等待时限到期后中断剩余任务并在重启后恢复；默认 false。' },
    } },
    execute: (args, exec) => request(exec.agent, args),
  })
  register({ name: 'cancel_harness_action', description: '取消本对话尚未开始退出的重启请求。',
    parameters: { type: 'object', properties: {} }, execute: (_args, exec) => control.cancel(exec.agent?.id) })
  register({ name: 'shutdown_harness', description: '说明如何停止 DSH；本插件不会用退出冒充关机，因为服务管理器可能自动重启。',
    parameters: { type: 'object', properties: {} },
    execute: () => ({ ok: false, message: '停止服务请使用服务管理器（例如 systemctl stop）。本插件只负责重启和恢复任务，未安排退出。' }) })
  register({ name: 'keep_going_status', description: '查看重启状态和当前对话的恢复问题；不会开始或暂停任务。',
    parameters: { type: 'object', properties: {} }, execute: (_args, exec) => status(exec.agent) })
  register({
    name: 'keep_going_clear_goal',
    description: '移除指定对话里已停止的目标（paused/blocked/complete），保留对话历史，同时清掉它的恢复记录。'
      + '仍在执行中的目标（active 且 armed）会被拒绝，需先暂停；active 但未在执行的目标会先记录一次暂停再移除。已归档对话不受影响。',
    parameters: { type: 'object', required: ['sessionId'], properties: {
      sessionId: { type: 'string', description: '目标所在对话的 sessionId（keep_going_status 的 tasks 里可见）。' },
    } },
    async execute(args) {
      try {
        const goal = await recovery.clearGoal(args.sessionId)
        return goal
          ? { ok: true, message: `已移除目标 ${goal.id}（历史保留；恢复记录已清除）。` }
          : { ok: true, message: '该对话当前没有目标，无需移除。' }
      } catch (error) {
        return { ok: false, message: `无法移除：${error.message}` }
      }
    },
  })

  ctx.effect(() => ctx.commands.register({ name: 'restart', recordInput: false, description: '等待任务后重启 DSH，并恢复未完成任务。',
    async handler({ agent }) { const result = await request(agent, {}); return { kind: result.ok ? 'success' : 'error', text: result.message } } }))
  ctx.effect(() => ctx.commands.register({ name: 'cancel-restart', recordInput: false, description: '取消本对话尚未退出的重启请求。',
    async handler({ agent }) { const result = await control.cancel(agent.id); return { kind: result.ok ? 'success' : 'error', text: result.message } } }))
  ctx.effect(() => ctx.commands.register({ name: 'keep-going', recordInput: false, description: '查看本对话的自动恢复状态。',
    handler({ agent }) { return { kind: 'success', text: JSON.stringify(status(agent), null, 2) } } }))

  // One-shot post-restart recovery: scan persisted sessions once at boot, then
  // poll() finishes due work and the plugin goes dormant.
  // ready includes discovery; callers must not observe a half-scanned startup.
  const ready = run(recovery.discover().then(() => { booting = false; return poll() }))
  // A public test/admin seam; no extra HTTP endpoint or process launcher.
  ctx.provide('keepGoing', { ready, poll, control, recovery, status })
}
