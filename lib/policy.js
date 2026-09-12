/**
 * Pure decision logic for dsh-keep-going — no I/O, no Cordis, no timers.
 *
 * Everything in this module is a total function of its arguments so the whole
 * restart policy is unit-testable without booting a DSH profile.
 * @module dsh-keep-going/policy
 */

/** Agent status meaning "a turn is in flight" on this agent. */
const RUNNING = 'running'

/**
 * Split the live agents into ones still worth waiting for and ones to ignore.
 *
 * A `running` agent with a recorded activity timestamp older than `stuckAgentMs`
 * is treated as stuck: a zombie turn would otherwise block every restart
 * forever. An agent with **no** recorded activity (this process has not observed
 * it yet) counts as live — never as stuck — so a restart can never silently
 * discard a turn merely because tracking has not caught up.
 * @param agents - Live agent handles exposing `id` and `status`.
 * @param lastActivityAt - Session id to last-activity epoch-ms.
 * @param now - Current epoch-ms.
 * @param stuckAgentMs - Inactivity after which a running agent counts as stuck.
 * @returns The live agents to await and the stale ones being skipped.
 */
export function partitionRunning(agents, lastActivityAt, now, stuckAgentMs) {
  const running = (agents || []).filter((agent) => agent && agent.status === RUNNING)
  const live = []
  const stale = []
  for (const agent of running) {
    const last = lastActivityAt.get(agent.id)
    if (typeof last === 'number' && now - last > stuckAgentMs) stale.push(agent)
    else live.push(agent)
  }
  return { live, stale }
}

/**
 * Whether an armed action may proceed now.
 * @param state - `live` count still in flight and whether the deadline passed.
 * @returns `'wait'` while live turns remain, otherwise `'exit'`.
 */
export function drainDecision(state) {
  if (state.live > 0 && !state.deadlineReached) return 'wait'
  return 'exit'
}

/**
 * Human label for an action, used in logs, prompts and tool results.
 * @param action - `'restart'` or `'shutdown'`.
 * @returns The Chinese label shown to operators.
 */
export function actionLabel(action) {
  return action === 'shutdown' ? '关闭' : '重启'
}

/** Default wake guidance injected into a session once DSH is back. */
export const DEFAULT_CONTINUE_PROMPT = 'DSH 已重启完成，请继续未完成的工作。'

/**
 * Sessions to wake after the restart.
 *
 * Exactly one: the session that asked. A restart is one conversation's request,
 * and the message it wakes up with is that conversation's own instruction —
 * sending it to any other conversation makes that one start working on someone
 * else's problem. Other conversations that were interrupted are left alone.
 * @param owner - Session that armed the action, or `null` for a user command.
 * @returns The owner alone, or an empty list for a user command.
 */
export function wakeTargets(owner) {
  return dedupe([owner])
}

/**
 * The message a woken session receives.
 * @param prompt - Session-specific or configured continue prompt.
 * @returns The notice text.
 */
export function continueMessage(prompt) {
  const body = typeof prompt === 'string' && prompt.trim() !== '' ? prompt.trim() : DEFAULT_CONTINUE_PROMPT
  return body
}

/**
 * Record an exit and decide whether waking is still allowed.
 *
 * Guards against a restart loop turning into an unbounded wake loop: the
 * returned history keeps only exits inside the window.
 * @param exits - Previously recorded exit timestamps, oldest first.
 * @param now - Current epoch-ms.
 * @param limit - Maximum exits allowed inside the window.
 * @param windowMs - Rolling window length in ms.
 * @returns The pruned history and whether a wake may be sent.
 */
export function stormDecision(exits, now, limit, windowMs) {
  const history = (exits || []).filter((at) => typeof at === 'number' && now - at <= windowMs)
  history.push(now)
  const allowWake = history.length <= limit
  return { history, allowWake, count: history.length }
}

/**
 * Build the durable marker written before the process exits.
 * @param input - Caller session, continue prompt, wake flag and exit history.
 * @returns A plain JSON-serializable marker document.
 */
export function buildMarker(input) {
  const marker = {
    version: 1,
    action: input.action,
    at: new Date(input.now).toISOString(),
    wake: input.wake === true,
    sessionIds: input.wake === true ? dedupe(input.sessionIds) : [],
    exits: input.exits || [],
  }
  if (typeof input.prompt === 'string' && input.prompt.trim() !== '') marker.prompt = input.prompt.trim()
  return marker
}

/**
 * Read a marker defensively; anything malformed is treated as absent.
 * @param raw - Parsed JSON of unknown shape.
 * @returns A normalized marker, or `null` when unusable.
 */
export function normalizeMarker(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const sessionIds = Array.isArray(raw.sessionIds)
    ? raw.sessionIds.filter((id) => typeof id === 'string' && id !== '')
    : []
  return {
    version: typeof raw.version === 'number' ? raw.version : 1,
    action: raw.action === 'shutdown' ? 'shutdown' : 'restart',
    at: typeof raw.at === 'string' ? raw.at : new Date(0).toISOString(),
    wake: raw.wake === true && sessionIds.length > 0,
    sessionIds,
    exits: Array.isArray(raw.exits) ? raw.exits.filter((at) => typeof at === 'number') : [],
    prompt: typeof raw.prompt === 'string' ? raw.prompt : undefined,
  }
}

/**
 * Deduplicate ids while preserving order.
 * @param ids - Candidate ids, possibly undefined or duplicated.
 * @returns Unique, non-empty ids in first-seen order.
 */
export function dedupe(ids) {
  const seen = new Set()
  const out = []
  for (const id of ids || []) {
    if (typeof id !== 'string' || id === '' || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}
