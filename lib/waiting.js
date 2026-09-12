/** Durable evidence that a task is waiting for a person, not for an auto-retry. */
function parseQuestions(raw) {
  try {
    const value = JSON.parse(raw)
    return Array.isArray(value.questions) ? value.questions.filter(q => typeof q.id === 'string' && typeof q.question === 'string') : []
  } catch { return [] }
}
function successfulAnswers(block, questions) {
  if (block.isError) return false
  const text = block.content?.filter(b => b.type === 'text').map(b => b.text).join('')
  try {
    const value = JSON.parse(text)
    return questions.length > 0 && Array.isArray(value.answers)
      && questions.every(q => value.answers.some(a => a.id === q.id && Array.isArray(a.selected)))
  } catch { return false }
}

/**
 * Questions survive synthetic TOOL_OUTCOME_UNKNOWN/TOOL_NOT_STARTED results.
 * A new ordinary human message in THIS session is an explicit reply or revised
 * instruction. No generated continue message, goal round, or copied history can
 * count as that answer. Approval grants are never replayed as allowed-once.
 */
export function outstandingWaits(events, inheritedEventCount = 0) {
  const questions = new Map(), approvals = new Map()
  for (const e of events) {
    if (e.seq < inheritedEventCount) continue
    if (e.type === 'tool/call' && e.data.name === 'ask_user_question') {
      questions.set(e.data.callId, { kind: 'question', id: e.data.callId, seq: e.seq,
        questions: parseQuestions(e.data.arguments) })
    }
    if (e.type === 'approval/asked') {
      approvals.set(e.data.id, { kind: 'approval', id: e.data.id, seq: e.seq,
        callId: e.data.callId ?? null, toolName: e.data.toolName, reason: e.data.reason ?? '' })
    }
    if (e.type === 'tool/result') {
      for (const block of e.data.message.content) {
        if (block.type !== 'tool-result') continue
        const waiting = questions.get(block.toolCallId)
        if (waiting && successfulAnswers(block, waiting.questions)) questions.delete(block.toolCallId)
        // Only a real successful tool settlement consumes its approval here.
        // A synthetic closer must not look like a completed authorized action.
        if (!block.isError) for (const [id, request] of approvals) {
          if (request.callId === block.toolCallId) approvals.delete(id)
        }
      }
    }
    if (e.type === 'user/message' && e.data.source?.kind === 'user') {
      for (const [id, q] of questions) if (e.seq > q.seq) questions.delete(id)
      // A message is NOT a security approval. The new request can be processed
      // normally, but the old action is not resumed using its old approval.
    }
  }
  return [...questions.values(), ...approvals.values()]
}
