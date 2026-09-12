/** DSH 0.1.5 public APIs: observe stored history, restore identity, flush writes. */
import { foldGoal } from '@deepseek-ai/dsh-goal'
import { CONTINUE, isRecoveryMessage } from './recovery-policy.js'
import { outstandingWaits } from './waiting.js'

/** Fold inbox receipts and the latest real work, ignoring empty closing turns. */
export function summarize(header, events, inheritedEventCount = 0) {
  const receipts = new Map(), lists = { 'next-turn': [], 'next-step': [] }
  const turns = new Map()
  let current = null, latest = null, goalSeq = -1
  for (const e of events) {
    if (e.type === 'goal/change') goalSeq = e.seq
    if (e.type === 'turn/start') {
      current = { turn: e.data.turn, startSeq: e.seq, hasWork: false, ordinary: false, reason: null }
      turns.set(current.turn, current)
    }
    if (e.type === 'agent/inbox/spliced') {
      const list = lists[e.data.target]
      if (!list) continue
      const entries = e.data.inserted.map(message => ({ message, seq: e.seq }))
      const removed = list.splice(e.data.start, e.data.removedCount ?? 0, ...entries)
      for (const old of removed) {
        receipts.set(old.message.id, { ...old, state: e.data.outcome === 'canceled' ? 'canceled' : 'claimed', turn: current?.turn })
        if (e.data.outcome !== 'canceled' && current) {
          current.hasWork = true
          current.ordinary ||= old.message.source?.kind !== 'goal'
        }
      }
      for (const entry of entries) receipts.set(entry.message.id, { ...entry, state: 'pending' })
    }
    if (e.type === 'user/message') {
      const old = receipts.get(e.data.id)
      receipts.set(e.data.id, { message: e.data, seq: old?.seq ?? e.seq, state: 'admitted', turn: current?.turn })
      if (current) {
        current.hasWork = true
        current.ordinary ||= e.data.source?.kind === 'user' || isRecoveryMessage(e.data)
      }
    }
    if (e.type === 'step/start' && current) current.hasWork = true
    if (e.type === 'turn/end') {
      const turn = turns.get(e.data.turn)
      if (turn) {
        turn.reason = e.data.reason; turn.endSeq = e.seq
        if (turn.hasWork && turn.startSeq >= inheritedEventCount) latest = turn
      }
      current = null
    }
  }
  if (current?.hasWork && current.startSeq >= inheritedEventCount) latest = current
  const projection = foldGoal(events)
  const goal = projection.goal ? { ...projection.goal, roundsStarted: projection.roundsStarted } : null
  const goalOwned = goalSeq >= inheritedEventCount
  return { header, cursor: events.at(-1)?.seq ?? -1, inheritedEventCount, goal, goalSeq, goalOwned,
    latest, receipts, pending: [...lists['next-turn'], ...lists['next-step']], waiting: outstandingWaits(events, inheritedEventCount) }
}

export function createNativeAdapter(ctx) {
  const cache = new Map()
  const from = (header, events, inherited = 0, cursor = events.at(-1)?.seq ?? -1) => {
    const saved = cache.get(header.id)
    if (saved?.cursor === cursor) return saved
    const facts = summarize(header, events, inherited)
    cache.delete(header.id); cache.set(header.id, facts)
    if (cache.size > 64) cache.delete(cache.keys().next().value)
    return facts
  }
  return {
    async list(signal) {
      const rows = await ctx.sessionQuery.listSessions(signal)
      return rows.filter(row => row.header.origin !== 'subagent' && row.header.cwd).map(row => row.header.id)
    },
    all() { return ctx.agents.list() },
    live() { return ctx.agents.list().filter(a => a.session.header.origin !== 'subagent') },
    snapshot(agent) { return from(agent.session.header, agent.session.snapshotEvents(), agent.session.inheritedEventCount) },
    disarmGoal(agent) { return ctx.goals.disarm(agent) },
    async inspect(id, signal) {
      const agent = ctx.agents.get(id)
      if (agent) return from(agent.session.header, agent.session.snapshotEvents(), agent.session.inheritedEventCount)
      const observation = await ctx.sessionQuery.observeSession(id, { signal, projectionMode: 'none' })
      try { return from(observation.header, observation.events, observation.inheritedEventCount, observation.cursor) }
      finally { observation[Symbol.dispose]() }
    },
    async restore(id) {
      const result = await ctx.sessionController.resolveAgent(id)
      if (result.error) throw result.error
      if (!result.agent) throw new Error(`DSH did not restore session ${id}`)
      return result.agent
    },
    async flush(agent) {
      const supported = await ctx.sessions.flush(agent.session)
      if (!supported) throw new Error('No session persistence service confirmed the checkpoint')
    },
    goal(agent) { return ctx.goals.get(agent) },
    resumeGoal(agent, goal) { return ctx.goals.resume(agent, { id: goal.id, revision: goal.revision }) },
    queue(agent, message, wakeMessage = message) {
      const pending = [...agent.inbox.nextTurn, ...agent.inbox.nextStep]
      if (pending.some(m => m.id === message.id)) {
        // Do not remove and append A: that turns the user's [A,B] queue into
        // [B,A]. A distinct next-step wake starts the ORIGINAL ordered inbox.
        const nudge = { id: `${wakeMessage.id}-wake`, role: 'user', content: [{ type: 'text', text: CONTINUE }],
          source: { kind: 'plugin', plugin: 'dsh-keep-going', form: 'instructions' } }
        if (pending.some(m => m.id === nudge.id)) agent.inbox.remove(nudge.id)
        agent.steer(nudge)
      } else agent.followup(message)
    },
  }
}
