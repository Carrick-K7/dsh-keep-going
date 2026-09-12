/** One pending restart; native maintenance holds prevent new work being started. */
import { randomUUID } from 'node:crypto'

export function createControl({ adapter, recovery, appExit, config, log = console, now = Date.now }) {
  let pending = null, exiting = false, checking = false
  const holds = new Map(), disarmed = new Map()
  const options = () => typeof config === 'function' ? config() : config
  const all = () => adapter.all ? adapter.all() : adapter.live()

  function hold(agent) {
    if (!pending || exiting || agent.status !== 'idle' || holds.has(agent.id)) return
    let release
    const promise = new Promise(resolve => { release = resolve })
    holds.set(agent.id, { agent, release })
    try {
      // Status idle may already be another maintenance operation. Never replace
      // its ownership; retry later. The hold honors disposal's cancellation.
      const task = agent.runMaintenance(signal => {
        if (signal.aborted) return
        signal.addEventListener('abort', release, { once: true })
        return promise.finally(() => signal.removeEventListener('abort', release))
      })
      Promise.resolve(task).catch(error => log.error(`[keep-going] maintenance ended: ${error.message}`))
        .finally(() => { if (holds.get(agent.id)?.release === release) holds.delete(agent.id) })
    } catch { holds.delete(agent.id); release() }
  }
  function disarmNewRounds(agent) {
    const goal = adapter.goal(agent)
    if (goal?.phase === 'active' && goal.activation === 'armed' && !disarmed.has(agent.id)) {
      disarmed.set(agent.id, { agent, id: goal.id })
      adapter.disarmGoal(agent) // process-local; never changes the durable phase to paused
    }
  }
  function observe(agent) {
    if (!pending || exiting) return
    disarmNewRounds(agent)
    hold(agent)
  }
  async function restoreExecution() {
    for (const { agent, release } of holds.values()) release()
    holds.clear()
    for (const { agent, id } of disarmed.values()) {
      const g = adapter.goal(agent)
      if (g?.id === id && g.phase === 'active' && g.activation !== 'armed') adapter.resumeGoal(agent, g)
    }
    disarmed.clear(); recovery.suspend(false)
  }
  async function cancel(owner) {
    if (exiting) return { ok: false, message: '退出已经开始，无法撤销。' }
    if (!pending) return { ok: true, message: '没有待执行的重启。' }
    if (!owner || owner !== pending.owner) return { ok: false, message: '只有发起重启的对话可以撤销。' }
    recovery.discardRequest(pending.requestKey)
    pending = null
    await restoreExecution()
    return { ok: true, message: '重启已取消，原任务继续执行。' }
  }
  async function request(owner, args = {}) {
    if (pending || exiting) return { ok: false, message: '已有重启请求，不会覆盖它的会话、提示或等待期限。' }
    if (typeof appExit !== 'function') return { ok: false, message: '当前 DSH 未提供正常退出接口；未安排重启。' }
    if (!owner) return { ok: false, message: '重启需要明确的发起会话。' }
    const waitMs = args.waitMs ?? options().drainTimeoutMs
    if (!Number.isSafeInteger(waitMs) || waitMs < 1000) return { ok: false, message: 'waitMs 必须是至少 1000 的整数。' }
    pending = { owner, id: randomUUID(), requestKey: null, deadline: now() + waitMs, ready: false, force: args.force === true }
    const token = pending
    recovery.suspend(true)
    try {
      token.requestKey = await recovery.recordRequest(owner, args.continuePrompt, token.id)
      if (pending !== token) {
        recovery.discardRequest(token.requestKey)
        return { ok: false, message: '重启请求已被取消。' }
      }
      for (const a of all()) observe(a)
      await recovery.checkpoint()
      if (pending !== token) {
        recovery.discardRequest(token.requestKey)
        return { ok: false, message: '重启请求已被取消。' }
      }
      token.ready = true
      return { ok: true, message: '重启已安排。等待当前任务结束；新收到的消息暂存，重启后自动继续。', requestId: token.id }
    } catch (error) {
      if (token.requestKey) recovery.discardRequest(token.requestKey)
      if (pending === token) { pending = null; await restoreExecution() }
      return { ok: false, message: `未安排重启：保存恢复记录失败（${error.message}）。` }
    }
  }
  async function check() {
    if (!pending?.ready || exiting || checking) return
    checking = true
    try {
      const token = pending
      for (const a of all()) observe(a)
      const running = all().filter(a => a.status === 'running' && !adapter.waitingForUser?.(a))
      const held = all().filter(a => a.status === 'idle' && !holds.has(a.id))
      if (running.length || held.length) {
        if (now() < token.deadline) return
        if (!token.force) {
          // Waiting longer must not silently cancel the request or cut a healthy
          // tool. Only the explicit force parameter authorizes a bounded cutoff.
          log.log(`[keep-going] restart still waiting for ${running.length + held.length} task(s); not treating silence as failure`)
          token.deadline = now() + options().drainTimeoutMs
          return
        }
      }
      await recovery.checkpoint()
      if (pending !== token) return
      // A user may answer while the checkpoint was awaited. Once real work has
      // resumed it is no longer safe to treat that agent as just a question wait.
      const stillBusy = all().some(a => (a.status === 'running' && !adapter.waitingForUser?.(a))
        || (a.status === 'idle' && !holds.has(a.id)))
      if (stillBusy && !(token.force && now() >= token.deadline)) return
      // Snapshot synchronously too, immediately before DSH begins disposal. Any
      // queued arrivals through that teardown are mirrored by recovery.observeEvent.
      recovery.beforeExit()
      exiting = true
      log.log(`[keep-going] requesting restart; ${running.length} turn(s) require recovery`)
      appExit(options().restartExitCode)
    } catch (error) {
      log.error(`[keep-going] restart withheld: ${error.message}`)
      // Do not proceed without durable state. Keep the request visible and
      // cancellable instead of replacing it with an untracked hard exit.
    } finally { checking = false }
  }
  return { request, cancel, check, observe,
    status: () => ({ pending: pending ? { owner: pending.owner, requestId: pending.id, deadline: pending.deadline, force: pending.force } : null, exiting }),
    async dispose() { pending = null; exiting = true; for (const h of holds.values()) h.release(); holds.clear(); disarmed.clear() },
  }
}
