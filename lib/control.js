/**
 * One pending restart.
 *
 * A scheduled restart is not an exit: while it waits, conversations keep
 * starting turns normally. Maintenance locks are taken only for the few
 * milliseconds of the handover itself, and only when no turn is running, so a
 * request that ends up waiting for a long task can never freeze the deployment.
 */
import { randomUUID } from 'node:crypto'

export function createControl({ adapter, recovery, appExit, config, log = console, now = Date.now }) {
  let pending = null, exiting = false, checking = false
  /** Locks held by the handover window only; never across waiting ticks. */
  const holds = new Map()
  const options = () => typeof config === 'function' ? config() : config
  const all = () => adapter.all ? adapter.all() : adapter.live()
  /** Turns that are actually working; a question waiting for a person is not. */
  const working = () => all().filter(a => a.status === 'running' && !adapter.waitingForUser?.(a))

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
  function releaseHolds() {
    for (const { release } of holds.values()) release()
    holds.clear()
  }
  async function cancel(owner) {
    if (exiting) return { ok: false, message: '退出已经开始，无法撤销。' }
    if (!pending) return { ok: true, message: '没有待执行的重启。' }
    if (!owner || owner !== pending.owner) return { ok: false, message: '只有发起重启的对话可以撤销。' }
    recovery.discardRequest(pending.requestKey)
    pending = null
    releaseHolds()
    recovery.suspend(false)
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
    // Recovery work pauses for the duration: a process that is about to exit
    // must not inject new continuations. The record stays durable either way.
    recovery.suspend(true)
    try {
      token.requestKey = await recovery.recordRequest(owner, args.continuePrompt, token.id)
      if (pending !== token) {
        recovery.discardRequest(token.requestKey)
        return { ok: false, message: '重启请求已被取消。' }
      }
      // Save durable state, but hold nothing: conversations may keep working
      // until the exit actually begins.
      await recovery.checkpoint()
      if (pending !== token) {
        recovery.discardRequest(token.requestKey)
        return { ok: false, message: '重启请求已被取消。' }
      }
      token.ready = true
      return { ok: true, message: '重启已安排。等待当前任务结束后退出；期间对话照常可用，退出时仍在进行的工作会在重启后继续。', requestId: token.id }
    } catch (error) {
      if (token.requestKey) recovery.discardRequest(token.requestKey)
      if (pending === token) { pending = null; recovery.suspend(false) }
      return { ok: false, message: `未安排重启：保存恢复记录失败（${error.message}）。` }
    }
  }
  async function check() {
    if (!pending?.ready || exiting || checking) return
    checking = true
    try {
      const token = pending
      const running = working()
      const forced = now() >= token.deadline && token.force
      if (running.length && !forced) {
        if (now() >= token.deadline) {
          // Waiting longer must not silently cancel the request or cut a healthy
          // tool. Only the explicit force parameter authorizes a bounded cutoff.
          log.log(`[keep-going] restart still waiting for ${running.length} task(s); conversations keep working and nothing is held`)
          token.deadline = now() + options().drainTimeoutMs
        }
        return
      }
      if (!running.length) {
        // Save durable state first — it may take a moment and must never be done
        // while conversations are locked.
        await recovery.checkpoint()
        if (pending !== token) { releaseHolds(); return }
        // Quiet moment: take the locks so no new turn starts during the handover,
        // then verify once more before asking DSH to exit.
        for (const agent of all()) hold(agent)
      } else {
        await recovery.checkpoint()
        if (pending !== token) { releaseHolds(); return }
      }
      // A user may answer while the checkpoint was awaited, and a message may
      // arrive inside the window we are freezing. Recorded arrivals are covered
      // by the synchronous snapshot below; anything actually running is not cut
      // without force.
      const resumed = working()
      const unheld = all().some(a => a.status === 'idle' && !holds.has(a.id))
      const cut = resumed.length || unheld
      if (cut && !(token.force && now() >= token.deadline)) { releaseHolds(); return }
      if (cut) log.log(`[keep-going] forcing restart after the deadline with ${resumed.length} unfinished task(s)`)
      // Snapshot synchronously too, immediately before DSH begins disposal. Any
      // queued arrivals through that teardown are mirrored by recovery.observeEvent.
      recovery.beforeExit()
      exiting = true
      log.log(`[keep-going] requesting restart; ${running.length} turn(s) require recovery`)
      appExit(options().restartExitCode)
    } catch (error) {
      log.error(`[keep-going] restart withheld: ${error.message}`)
      // Do not proceed without durable state. Keep the request visible and
      // cancellable instead of replacing it with an untracked hard exit, and do
      // not keep other conversations locked while we wait.
      releaseHolds()
    } finally { checking = false }
  }
  return { request, cancel, check,
    status: () => ({ pending: pending ? { owner: pending.owner, requestId: pending.id, deadline: pending.deadline, force: pending.force } : null, exiting,
      holding: holds.size }),
    async dispose() { pending = null; exiting = true; releaseHolds() },
  }
}
