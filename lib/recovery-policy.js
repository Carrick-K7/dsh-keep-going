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
export function retryableEnd(reason) {
  return !reason || reason.kind === 'interrupted' || reason.kind === 'error'
    || (reason.kind === 'aborted' && reason.reason?.kind === 'disposed')
}
export function failureCategory(reason) {
  const code = String(reason?.error?.code || '').toLowerCase()
  if (/quota|insufficient|balance|credit/.test(code)) return 'quota'
  if (/credential|auth|api.key|no.adapter|unknown.provider/.test(code)) return 'credentials'
  if (reason?.kind === 'max-tokens') return 'output-limit'
  return 'temporary'
}

/** Return durable original work only. Copied history does not create new work. */
export function candidates(facts) {
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
  if (canRecoverTurn && facts.latest?.hasWork && facts.latest.ordinary
      && retryableEnd(facts.latest.reason)) {
    jobs.push({ kind: 'turn', workId: `turn:${facts.latest.startSeq}:${facts.latest.turn}`, turn: facts.latest.turn,
      startSeq: facts.latest.startSeq, endSeq: facts.latest.endSeq ?? null })
  }
  return jobs
}

/** Revalidate a saved job against current durable facts before any message. */
export function eligible(job, facts, currentInstance = null) {
  if (facts.header.origin === 'subagent') return false
  if (job.kind === 'input' && job.inputSeq < facts.inheritedEventCount) return false
  if (job.kind === 'turn' && job.startSeq < facts.inheritedEventCount) return false
  if (job.kind === 'goal') return facts.goalOwned && facts.goal?.id === job.goalId && facts.goal.phase === 'active'
  if (job.kind === 'request') {
    if (facts.goal && facts.goal.phase !== 'active' && facts.goalSeq > job.requestSeq) return false
    if (facts.latest?.startSeq > job.requestSeq && !retryableEnd(facts.latest.reason)) return false
    return true
  }
  if (facts.goalOwned && facts.goal?.phase === 'active' && job.kind !== 'input') return false // use goal driver, not an extra continue
  const sourceSeq = job.startSeq ?? job.inputSeq ?? -1
  if (facts.goal && facts.goal.phase !== 'active' && sourceSeq <= facts.goalSeq) return false
  const delivered = job.messageId ? facts.receipts.get(job.messageId) : undefined
  if (delivered?.state === 'pending') return true
  if (delivered?.state === 'claimed' || delivered?.state === 'admitted') {
    return facts.latest?.turn === delivered.turn && retryableEnd(facts.latest.reason)
  }
  if (job.kind === 'input') {
    const receipt = facts.receipts.get(job.inputId)
    if (!receipt || receipt.seq < facts.inheritedEventCount || job.inputSeq < facts.inheritedEventCount) return false
    if (receipt.state === 'pending') return true
    if (receipt.state === 'canceled') return job.savedInput !== undefined && job.disposalExpected === true
      && (currentInstance === null || job.disposalInstance !== currentInstance)
    return receipt.turn === facts.latest?.turn && retryableEnd(facts.latest.reason)
  }
  return facts.latest?.turn === job.turn && retryableEnd(facts.latest.reason)
}

export function retryDelay(attempts, minMs, maxMs) {
  return Math.min(maxMs, minMs * 2 ** Math.min(16, Math.max(0, attempts - 1)))
}
