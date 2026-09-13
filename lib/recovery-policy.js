/** Restart decisions based on durable task identity, never elapsed silence. */
import { createHash } from 'node:crypto'

export const CONTINUE = 'DSH 已重新启动。请根据本对话的记录继续尚未完成的任务，不要重复已经完成的操作；对结果不确定的工具操作先核实。'
export const keyFor = (sessionId, workId) => createHash('sha256').update(JSON.stringify([sessionId, workId])).digest('hex')
export const messageIdFor = (key, attempt = 0) => `keep-going-${key}-${attempt}`
export const isRecoveryMessage = (message) => message?.source?.kind === 'plugin' && message.source.plugin === 'dsh-keep-going'

/** Explicit user cancellation and terminal goals always beat recovery. */
export function stoppedGoal(facts) {
  return facts.goal && facts.goal.phase !== 'active'
}
/**
 * Whether an ended turn still counts as restart-interrupted work.
 *
 * Only a crash closer (`interrupted`) or an error that classification may still
 * judge transient qualifies. A disposal counts **only** when this plugin itself
 * recorded the exit (`disposalExpected`): a session stopped by a person, by HMR,
 * or by ordinary agent lifecycle must never be resurrected by a timer.
 * @param reason - The turn/end reason, or null while a turn is still open.
 * @param job - The owning recovery record, for its recorded exit intent.
 * @returns True when the work may still be recovered.
 */
export function retryableEnd(reason, job = {}) {
  if (!reason) return true
  if (reason.kind === 'interrupted') return true
  if (reason.kind === 'error') return true // classification decides how far
  if (reason.kind === 'aborted') {
    return reason.reason?.kind === 'disposed' && job.disposalExpected === true
  }
  return false
}
/**
 * Whether a job we already delivered is waiting for us to read its verdict.
 *
 * A continuation that was admitted and then ended badly must be *settled*
 * (reported, or dropped when it completed) rather than deleted as ineligible:
 * silent removal is how a stopped session used to look like nothing happened.
 * @param job - The owning recovery record.
 * @param facts - Session facts snapshot.
 * @returns True when the delivered continuation owns the latest finished turn.
 */
export function awaitingVerdict(job, facts) {
  if (!job.messageId || job.kind === 'goal') return false
  const receipt = facts.receipts?.get(job.messageId)
  if (receipt?.state !== 'admitted' && receipt?.state !== 'claimed') return false
  return facts.latest?.turn === receipt.turn && facts.latest?.endSeq !== null
}
/**
 * Whether an ending is a *restart* interruption — the only thing this plugin
 * recovers. `interrupted` is how the kernel closes a turn whose process died;
 * `disposed` counts only when this plugin recorded the exit itself.
 *
 * A steady-state failure (provider error, blocked turn, user stop, hook abort)
 * is never restart work: recovering it would re-run tasks the user watched fail.
 * @param reason - The turn/end reason, or null while a turn is still open.
 * @param job - The owning recovery record, for its recorded exit intent.
 * @returns True only for work a restart interrupted.
 */
export function interruptedByRestart(reason, job = {}) {
  if (!reason) return false
  if (reason.kind === 'interrupted') return true
  return reason.kind === 'aborted' && reason.reason?.kind === 'disposed' && job.disposalExpected === true
}
export function failureSummary(reason) {
  return reason?.error?.message || reason?.kind || 'unknown failure'
}
export function failureCategory(reason) {
  const code = String(reason?.error?.code || '').toLowerCase()
  const message = String(reason?.error?.message || '')
  const hay = `${code} ${message}`.toLowerCase()
  // Quota exhaustion is never retried: no amount of waiting adds credit.
  if (/quota|insufficient|balance|credit|usage limit|reached your .*limit|额度|余额|配额|限额|用尽/.test(hay)) return 'quota'
  if (/(?:^|[^0-9])402(?![0-9])/.test(hay)) return 'quota'
  if (/credential|auth|api.key|no.adapter|unknown.provider/.test(hay)) return 'credentials'
  // A hard client error is a configuration or request problem: retrying it on a
  // timer would loop forever. 408 (timeout) and 429 (rate limit) stay retryable.
  const status = (code.match(/(?:^|[^0-9])(\d{3})(?![0-9])/) || message.match(/(?:^|[^0-9])(\d{3})(?![0-9])/) || [])[1]
  if (status && status[0] === '4' && status !== '408' && status !== '429') return 'client-error'
  if (reason?.kind === 'max-tokens') return 'output-limit'
  return 'temporary'
}

/** Return durable original work only. Copied history does not create new work. */
export function candidates(facts) {
  if (facts.archived) return [] // archived conversations are never recovered
  if (facts.header.origin === 'subagent') return [] // parent/provider owns subagent revival
  const jobs = []
  if (facts.goal?.phase === 'active' && facts.goalOwned) {
    jobs.push({ kind: 'goal', workId: `goal:${facts.goal.id}`, goalId: facts.goal.id })
  }
  // An explicit pause/finish governs older tasks, but not a later human request.
  const ownGoal = facts.goalOwned ? facts.goal : null
  const canRecoverTurn = !ownGoal || (facts.latest?.startSeq > facts.goalSeq && ownGoal.phase !== 'active')
  for (const pending of facts.pending) {
    if (pending.seq < facts.inheritedEventCount) continue
    if (pending.message.source?.kind !== 'user') continue
    if (facts.goal && facts.goal.phase !== 'active' && pending.seq <= facts.goalSeq) continue
    jobs.push({ kind: 'input', workId: `input:${pending.message.id}`, inputId: pending.message.id, inputSeq: pending.seq })
  }
  // A turn that has not ended yet is recorded too: at checkpoint time the exit
  // that is about to interrupt it has not happened. Recording is harmless — the
  // coordinator never messages a session whose agent is still running — and it is
  // what makes work visible if the process dies before the turn can end.
  const ended = facts.latest?.reason
  if (canRecoverTurn && facts.latest?.hasWork && facts.latest.ordinary
      && (!ended || interruptedByRestart(ended, { disposalExpected: false }))) {
    jobs.push({ kind: 'turn', workId: `turn:${facts.latest.startSeq}:${facts.latest.turn}`, turn: facts.latest.turn,
      startSeq: facts.latest.startSeq, endSeq: facts.latest.endSeq ?? null })
  }
  return jobs
}

/** Revalidate a saved job against current durable facts before any message. */
export function eligible(job, facts, currentInstance = null) {
  if (facts.archived) return false // archived conversations are never recovered
  if (facts.header.origin === 'subagent') return false
  if (job.kind === 'input' && job.inputSeq < facts.inheritedEventCount) return false
  if (job.kind === 'turn' && job.startSeq < facts.inheritedEventCount) return false
  if (job.kind === 'goal') return facts.goalOwned && facts.goal?.id === job.goalId && facts.goal.phase === 'active'
  if (job.kind === 'request') {
    if (facts.goal && facts.goal.phase !== 'active' && facts.goalSeq > job.requestSeq) return false
    if (facts.latest?.startSeq > job.requestSeq && !retryableEnd(facts.latest.reason, job)) return false
    return true
  }
  if (facts.goalOwned && facts.goal?.phase === 'active' && job.kind !== 'input') return false // use goal driver, not an extra continue
  const sourceSeq = job.startSeq ?? job.inputSeq ?? -1
  if (facts.goal && facts.goal.phase !== 'active' && sourceSeq <= facts.goalSeq) return false
  const delivered = job.messageId ? facts.receipts.get(job.messageId) : undefined
  if (delivered?.state === 'pending') return true
  if (delivered?.state === 'claimed' || delivered?.state === 'admitted') {
    return facts.latest?.turn === delivered.turn && retryableEnd(facts.latest.reason, job)
  }
  if (job.kind === 'input') {
    const receipt = facts.receipts.get(job.inputId)
    if (!receipt || receipt.seq < facts.inheritedEventCount || job.inputSeq < facts.inheritedEventCount) return false
    if (receipt.state === 'pending') return true
    if (receipt.state === 'canceled') return job.savedInput !== undefined && job.disposalExpected === true
      && (currentInstance === null || job.disposalInstance !== currentInstance)
    return receipt.turn === facts.latest?.turn && retryableEnd(facts.latest.reason, job)
  }
  return facts.latest?.turn === job.turn && retryableEnd(facts.latest.reason, job)
}

export function retryDelay(attempts, minMs, maxMs) {
  return Math.min(maxMs, minMs * 2 ** Math.min(16, Math.max(0, attempts - 1)))
}
