/** Durable recovery coordinator. No process management and no channel-specific text. */
import { randomUUID } from 'node:crypto'
import { CONTINUE, awaitingVerdict, candidates, eligible, failureCategory, failureSummary, interruptedByRestart, keyFor, messageIdFor, retryDelay } from './recovery-policy.js'

/** Statuses that mean restart recovery is still in progress. waiting-user
 *  keeps it in progress until the human answers; blocked is terminal. */
const ACTIVE_STATUSES = new Set(['pending', 'retrying', 'delivered', 'handoff', 'waiting-user'])

export function createRecovery({ adapter, store, config, log = console, now = Date.now }) {
  const instance = randomUUID(), busy = new Map()
  /** Goals already re-armed in THIS process lifetime. A goal driver error that
   *  disarms one again is DSH's own lifecycle: we never loop re-arms, only the
   *  next process restart may recover it. */
  const rearmedGoalIds = new Set()
  let suspended = false, stopped = false, disposing = false, scanPending = null, ioError = null
  const options = () => typeof config === 'function' ? config() : config
  /** Hard cap on automatic attempts for one task. After this it is reported as
   *  blocked — a failing task must never be retried on a timer forever. */
  const maxAttempts = () => Math.max(1, Number(options().maxAttempts) || 3)
  const recent = store.read().recentRestarts.filter(t => t >= now() - (options().restartWindowMs ?? 60000))
  const cooldownUntil = recent.length >= (options().restartBurstLimit ?? 5) ? recent.at(-1) + (options().restartWindowMs ?? 60000) : 0
  const change = (fn) => {
    try { const saved = store.update(fn); ioError = null; return saved }
    catch (error) { ioError = error; throw error }
  }
  const remove = key => { if (store.read().jobs[key]) change(s => { delete s.jobs[key] }) }
  const update = (key, fields) => {
    const old = store.read().jobs[key]
    if (!old || Object.entries(fields).every(([name, value]) => JSON.stringify(old[name]) === JSON.stringify(value))) return
    return change(s => { if (s.jobs[key]) Object.assign(s.jobs[key], fields) })
  }
  function enqueue(id, work, extra = {}) {
    if (work.kind === 'goal' && rearmedGoalIds.has(work.goalId)) return null
    const key = keyFor(id, work.workId)
    const existing = store.read().jobs[key]
    if (existing) {
      // Work first seen during normal operation is only a checkpoint. The moment
      // an exit or a fresh boot claims it, it becomes restart work.
      if (extra.restartScoped === true && existing.restartScoped !== true) update(key, { restartScoped: true })
      return key
    }
    change(s => {
      if (!s.jobs[key]) s.jobs[key] = { ...work, sessionId: id, key, messageId: messageIdFor(key),
        attempt: 0, failures: 0, retryAt: 0, status: 'pending', createdAt: now(), ...extra }
    })
    return key
  }

  /** A waiting-user job resumes only when the human actually answered. */
  function reactivate(job, facts) {
    if (job.status === 'waiting-user' && !(facts.waiting?.length)) {
      update(job.key, { status: 'pending', retryAt: 0 })
      return true
    }
    return false
  }

  async function discoverSession(id, { restartScoped = false } = {}) {
    const facts = await adapter.inspect(id)
    if (stopped || disposing) return facts
    const work = candidates(facts)
    const snapshot = store.read()
    // A still-pending recovery owns this session's interrupted recovery turns;
    // don't generate a second job just because its new continuation turn crashed.
    const ownsContinuation = Object.values(snapshot.jobs).some(job => job.sessionId === id && job.kind !== 'goal')
    for (const candidate of work) {
      if (candidate.kind === 'turn' && ownsContinuation) continue
      if (candidate.kind === 'goal' && rearmedGoalIds.has(candidate.goalId)) continue
      const extra = { restartScoped }
      if (candidate.kind === 'input') {
        const input = facts.pending.find(p => p.message.id === candidate.inputId)
        if (input) extra.savedInput = input.message
      }
      enqueue(id, candidate, extra)
    }
    // Durable terminal facts cancel old recovery, not just goal activation.
    for (const job of Object.values(store.read().jobs)) {
      if (job.sessionId !== id) continue
      if (reactivate(job, facts)) continue
      if (job.kind === 'request') continue
      if (awaitingVerdict(job, facts)) continue
      if (!eligible(job, facts, instance)) remove(job.key)
    }
    return facts
  }

  async function discover() {
    if (scanPending) return scanPending
    scanPending = (async () => {
      for (const id of await adapter.list()) {
        if (stopped) break
        try { await discoverSession(id, { restartScoped: true }) }
        catch (error) { log.error(`[keep-going] cannot inspect ${id}: ${error.message}`) }
      }
    })().finally(() => { scanPending = null })
    return scanPending
  }

  /** The ended turn that carries this job's own verdict, or null while it has none. */
  function ownEnding(job, facts) {
    const verdict = facts.latest?.reason ?? null
    if (job.kind === 'turn') return facts.latest?.turn === job.turn ? verdict : null
    const receipt = facts.receipts.get(job.inputId)
    if (!receipt || receipt.state === 'pending') return null // not yet this session's turn
    return receipt.turn === facts.latest?.turn ? verdict : null
  }

  function message(job) {
    return { id: job.messageId, role: 'user', content: [{ type: 'text', text: job.prompt || CONTINUE }],
      source: { kind: 'plugin', plugin: 'dsh-keep-going', form: 'instructions' } }
  }

  async function recover(job) {
    const valid = () => !stopped && !suspended && !disposing
      && store.read().jobs[job.key]?.messageId === job.messageId
    if (!valid() || (job.kind === 'request' && job.originInstance === instance)) return
    const before = await adapter.inspect(job.sessionId)
    if (!valid()) return
    if (!eligible(job, before, instance) && !awaitingVerdict(job, before)) { remove(job.key); return }
    const agent = await adapter.restore(job.sessionId)
    if (!valid()) return
    // An unrelated user action may have arrived during the awaited restore.
    const facts = await adapter.inspect(job.sessionId)
    if (!valid()) return
    if (!eligible(job, facts, instance) && !awaitingVerdict(job, facts)) { remove(job.key); return }
    const pendingReply = job.kind === 'input' ? facts.receipts.get(job.inputId) : null
    const isHumanReply = pendingReply?.state === 'pending' && pendingReply.message.source?.kind === 'user'
      && facts.waiting?.every(q => pendingReply.seq > q.seq)
    if (facts.waiting?.length && !isHumanReply) {
      update(job.key, { status: 'waiting-user', waiting: facts.waiting, retryAt: 0 })
      return
    }
    if (agent.status === 'running') return

    // Already queued and not yet claimed (the session is busy with other
    // durable work): nothing to do. Re-queueing or re-steering every tick would
    // only spam the log — the message is already durably pending in the inbox.
    if (job.status === 'delivered') {
      const tracked = job.kind === 'input' ? facts.receipts.get(job.inputId) : facts.receipts.get(job.messageId)
      if (tracked?.state === 'pending') return
    }

    // A record made while nothing was restarting exists only so a later crash can
    // find unfinished work — never so this plugin can re-run a turn the user just
    // watched fail. Retire it once its own work has ended without a restart.
    // Requests and goals are explicit restart work with their own paths, and a
    // human message that is still pending is always ours to deliver.
    if ((job.kind === 'turn' || job.kind === 'input') && !job.restartScoped) {
      const ended = ownEnding(job, facts)
      if (ended && !interruptedByRestart(ended, job)) { remove(job.key); return }
    }

    const receiptForJob = facts.receipts.get(job.messageId) || (job.kind === 'input' ? facts.receipts.get(job.inputId) : null)
    const ownsLastTurn = job.kind === 'goal'
      ? facts.goalSeq <= (facts.latest?.endSeq ?? -1)
      : job.kind === 'input' ? receiptForJob?.turn === facts.latest?.turn && receiptForJob?.state !== 'pending'
        : facts.latest?.turn === job.turn || receiptForJob?.turn === facts.latest?.turn
    const error = ownsLastTurn ? facts.latest?.reason : null
    if (error && ['blocked', 'max-tokens'].includes(error.kind) && job.kind !== 'request') {
      update(job.key, { status: 'blocked', lastError: `Task stopped: ${error.kind}`, retryAt: 0 }); return
    }
    if (error?.kind === 'aborted' && error.reason?.kind === 'user') {
      update(job.key, { status: 'blocked', lastError: 'User canceled the task', retryAt: 0 }); return
    }
    // A disposal we did not record ourselves is not restart recovery: somebody
    // stopped this session (or its lifecycle ended) and we must not resurrect it.
    if (error?.kind === 'aborted' && !(error.reason?.kind === 'disposed' && job.disposalExpected === true)) {
      update(job.key, { status: 'blocked', lastError: `Stopped outside a restart (${error.reason?.kind || 'unknown'}) — not retried`, retryAt: 0 }); return
    }
    if (error?.kind === 'error' && failureCategory(error) !== 'temporary') {
      update(job.key, { status: 'blocked', lastError: failureSummary(error), retryAt: 0 }); return
    }

    // Our own delivered continuation already ran and its turn has ended. Read the
    // verdict here, BEFORE the delivery-retry path: a task that visibly failed is
    // reported rather than re-sent on a timer. Goal jobs never carry a message of
    // their own (the goal branch above owns them); requests settle like any other.
    const deliveredReceipt = job.kind === 'goal' ? undefined : facts.receipts.get(job.messageId)
    if ((deliveredReceipt?.state === 'admitted' || deliveredReceipt?.state === 'claimed')
        && facts.latest?.turn === deliveredReceipt.turn) {
      const reason = facts.latest.reason
      if (!reason || reason.kind === 'completed') { remove(job.key); return }
      if (!interruptedByRestart(reason, job)) {
        update(job.key, { status: 'blocked', lastError: `Continuation failed: ${failureSummary(reason)}`, retryAt: 0 })
        log.log(`[keep-going] continuation for ${job.sessionId} failed and will not be retried: ${failureSummary(reason)}`)
        return
      }
      // Only another restart may continue it, and only a bounded number of
      // times: an interruption that keeps repeating is reported, not looped.
      const deliveries = (job.attempt ?? 0) + 1
      if (deliveries >= maxAttempts()) {
        update(job.key, { status: 'blocked', attempt: deliveries, retryAt: 0,
          lastError: `Continuation interrupted ${deliveries} times: ${failureSummary(reason)}` })
        log.log(`[keep-going] giving up on ${job.sessionId} after ${deliveries} deliveries: ${failureSummary(reason)}`)
        return
      }
      // The previous continuation message was consumed by the turn that just
      // ended, so this attempt needs its own identity to avoid deduplication.
      job = { ...job, attempt: deliveries }
      update(job.key, { attempt: deliveries })
    }

    // Only work we never delivered may retry a provider error: a continuation
    // that already ran is settled above and must never be replayed on a timer.
    if (error?.kind === 'error' && !job.attempt && job.lastFailureSeq !== facts.latest.endSeq) {
      const failures = job.failures + 1
      // Bounded: a task that keeps erroring is reported, never retried forever.
      if (failures >= maxAttempts()) {
        update(job.key, { failures, lastFailureSeq: facts.latest.endSeq, status: 'blocked',
          lastError: `Failed ${failures} times: ${failureSummary(error)}`, retryAt: 0 })
        log.log(`[keep-going] giving up on ${job.sessionId} after ${failures} attempts: ${failureSummary(error)}`)
        return
      }
      update(job.key, { failures, lastFailureSeq: facts.latest.endSeq, status: 'retrying',
        retryAt: now() + retryDelay(failures, options().retryMinMs, options().retryMaxMs),
        lastError: failureSummary(error) })
      return
    }
    if (job.retryAt > now()) return

    if (job.kind === 'goal') {
      if (rearmedGoalIds.has(job.goalId)) { remove(job.key); return }
      const goal = adapter.goal(agent)
      if (!goal || goal.id !== job.goalId || goal.phase !== 'active') { remove(job.key); return }
      if (goal.roundsStarted >= goal.maxGoalRounds) {
        update(job.key, { status: 'blocked', lastError: 'Goal round limit reached', retryAt: 0 }); return
      }
      if (goal.activation === 'armed') { remove(job.key); return }
      adapter.resumeGoal(agent, goal)
      await adapter.flush(agent)
      if (!valid()) return
      // One re-arm per restart, then native driver owns the goal entirely. We
      // never re-arm periodically: a later native disarm is the harness's own
      // lifecycle, and only the next process restart can recover it.
      rearmedGoalIds.add(job.goalId)
      remove(job.key)
      log.log(`[keep-going] goal execution restored for ${job.sessionId}`)
      return
    }

    // An old input whose turn was interrupted belongs to the goal driver when
    // an active owned goal exists: hand off instead of sending an ordinary
    // CONTINUE. A still-pending human message is restored to the inbox first.
    if (job.kind === 'input' && facts.goalOwned && facts.goal?.phase === 'active') {
      const original = facts.receipts.get(job.inputId)
      const pending = original?.state === 'pending' ? original.message
        : (original?.state === 'canceled' && job.disposalExpected ? job.savedInput : null)
      if (pending) adapter.queue(agent, pending, message(job))
      enqueue(job.sessionId, { kind: 'goal', workId: `goal:${facts.goal.id}`, goalId: facts.goal.id })
      if (valid()) remove(job.key)
      return
    }
    const receipt = facts.receipts.get(job.messageId)
    if (job.kind === 'request' && facts.goalOwned && facts.goal?.phase === 'active') {
      if (receipt?.state === 'admitted') {
        await adapter.flush(agent)
        if (valid()) remove(job.key)
        return
      }
      // Retain caller-only context until actual admission, not merely an inbox
      // flush: native disposal may clear that inbox before the goal can use it.
      if (receipt?.state !== 'pending') agent.inject(message(job))
      await adapter.flush(agent)
      if (!valid()) return
      enqueue(job.sessionId, { kind: 'goal', workId: `goal:${facts.goal.id}`, goalId: facts.goal.id })
      update(job.key, { status: 'handoff', retryAt: 0 })
      return
    }
    const original = job.kind === 'input' ? facts.receipts.get(job.inputId) : null
    const input = original?.state === 'pending' ? original.message
      : (original?.state === 'canceled' && job.disposalExpected ? job.savedInput : null)
    // One identity per attempt. A delivery that threw before reaching the inbox
    // keeps the same id, so the native queue recognises it and nudges instead of
    // appending a duplicate; an attempt whose turn already ran gets a new one.
    const delivery = { ...message(job), id: messageIdFor(job.key, job.attempt ?? 0) }
    adapter.queue(agent, input || delivery, delivery)
    await adapter.flush(agent)
    if (!valid()) return
    // Keep the job until the real turn settles. flush acknowledges a queued
    // message, not successful completion of the user's work.
    update(job.key, { status: 'delivered', messageId: delivery.id, retryAt: now() + options().retryMinMs })
    log.log(`[keep-going] continuation delivered to ${job.sessionId}`)
  }

  async function step(job) {
    try { await recover(job) }
    catch (error) {
      if (stopped || suspended || disposing || !store.read().jobs[job.key]) return
      const failures = job.failures + 1
      // Delivery itself failed (queue/flush/restore). Retrying is safe, but only
      // a bounded number of times; then report the real error and stop.
      if (failures >= maxAttempts()) {
        update(job.key, { failures, status: 'blocked',
          lastError: `Delivery failed ${failures} times: ${error.message}`, retryAt: 0 })
        log.error(`[keep-going] giving up on ${job.sessionId} after ${failures} delivery failures: ${error.message}`)
        return
      }
      const retryAt = now() + retryDelay(failures, options().retryMinMs, options().retryMaxMs)
      update(job.key, { failures, retryAt, status: 'retrying', lastError: String(error.message || error) })
      log.error(`[keep-going] recovery will retry for ${job.sessionId}: ${error.message}`)
    }
  }

  async function tick() {
    if (stopped || suspended || now() < cooldownUntil) return
    const jobs = Object.values(store.read().jobs)
      .filter(j => ['pending', 'retrying', 'delivered', 'handoff'].includes(j.status)
        && (j.status === 'delivered' || j.status === 'handoff' || j.retryAt <= now()))
      .sort((a, b) => ({ request: 0, input: 1, turn: 2, goal: 3 }[a.kind] - { request: 0, input: 1, turn: 2, goal: 3 }[b.kind]))
    for (const job of jobs) {
      if (stopped || suspended) return
      if (busy.has(job.sessionId)) continue
      // Serialized per session, including retries racing with native startup.
      const task = step(job).finally(() => busy.delete(job.sessionId))
      busy.set(job.sessionId, task)
      await task
    }
  }

  async function recordRequest(owner, prompt, requestId) {
    if (!owner) return null
    const facts = await adapter.inspect(owner)
    return enqueue(owner, { kind: 'request', workId: `request:${requestId}`, requestSeq: facts.cursor },
      { originInstance: instance, ...(prompt ? { prompt } : {}) })
  }

  async function checkpoint() {
    if (ioError) throw ioError
    for (const agent of adapter.live()) {
      await discoverSession(agent.id, { restartScoped: true })
      await adapter.flush(agent)
    }
    if (ioError) throw ioError
  }

  // These hooks are synchronous: queued messages must be recorded before the
  // native disposed-cancel removes them. They never resume or send work.
  function captureLive(agent) {
    const facts = adapter.snapshot(agent)
    const saved = Object.values(store.read().jobs)
    for (const work of candidates(facts)) {
      if (work.kind === 'turn' && saved.some(j => j.sessionId === agent.id && j.kind !== 'goal')) continue
      if (work.kind === 'goal' && rearmedGoalIds.has(work.goalId)) continue
      const input = work.kind === 'input' ? facts.pending.find(p => p.message.id === work.inputId) : null
      enqueue(agent.id, work, { restartScoped: disposing,
        ...(input ? { savedInput: input.message, disposalExpected: disposing, ...(disposing ? { disposalInstance: instance } : {}) } : {}) })
    }
    for (const job of Object.values(store.read().jobs)) {
      if (job.sessionId !== agent.id) continue
      // An exit is under way for this live session: everything recorded for it is
      // restart work from now on, including a record made during normal operation.
      if (disposing && job.restartScoped !== true) update(job.key, { restartScoped: true })
      if (disposing && job.kind === 'input') update(job.key, { disposalExpected: true, disposalInstance: instance })
      const current = store.read().jobs[job.key]
      if (current && reactivate(current, facts)) continue
      if (current && awaitingVerdict(current, facts)) continue
      if (current && !eligible(current, facts, disposing ? null : instance)) remove(current.key)
    }
  }
  function beforeExit() {
    if (disposing) return
    if (ioError) throw ioError
    disposing = true; suspended = true
    try {
      for (const agent of adapter.live()) captureLive(agent)
      change(s => {
        s.recentRestarts = s.recentRestarts.filter(t => t >= now() - (options().restartWindowMs ?? 60000))
        s.recentRestarts.push(now())
      })
    } catch (error) { disposing = false; throw error }
  }
  function observeEvent(agent, event) {
    if (stopped || !['turn/start', 'turn/end', 'step/start', 'goal/change', 'user/message', 'agent/inbox/spliced', 'tool/call', 'tool/result', 'approval/asked', 'approval/decided'].includes(event.type)) return
    try { captureLive(agent) }
    catch (error) { ioError = error; log.error(`[keep-going] recovery checkpoint failed for ${agent.id}: ${error.message}`) }
  }

  /** Clear a stopped goal in another session (tombstone keeps history), and
   *  drop any recovery job for it. Refuses goals that are still active. */
  async function clearGoal(sessionId) {
    const goal = await adapter.clearGoal(sessionId)
    change(s => {
      for (const job of Object.values(s.jobs)) {
        if (job.sessionId === sessionId && (job.kind === 'goal' || (goal && job.goalId === goal.id))) delete s.jobs[job.key]
      }
    })
    if (goal) log.log(`[keep-going] cleared goal ${goal.id} in ${sessionId} (tombstone kept)`)
    return goal
  }

  return { discover, discoverSession, tick, recordRequest, checkpoint, beforeExit, observeEvent, clearGoal,
    discardRequest: key => { if (key) remove(key) },
    suspend: value => { suspended = value },
    stop: () => { stopped = true; suspended = true },
    /** True only while restart recovery has unfinished work — the plugin is
     *  dormant outside that window and never scans periodically. */
    active: () => stopped !== true && Object.values(store.read().jobs).some(j => ACTIVE_STATUSES.has(j.status)),
    status: () => ({ instance, suspended, pending: Object.values(store.read().jobs), storageError: ioError?.message ?? null }),
    async retry() {
      change(s => { for (const job of Object.values(s.jobs)) Object.assign(job, { status: 'pending', retryAt: 0, failures: 0 }) })
      await tick()
    },
  }
}
