import assert from 'node:assert/strict'
import test from 'node:test'
import { outstandingWaits } from '../lib/waiting.js'
const question = { id: 'choice', question: 'Which target should be used?', options: [{ label: 'A' }, { label: 'B' }] }
const call = { seq: 3, type: 'tool/call', data: { callId: 'call-question', name: 'ask_user_question', arguments: JSON.stringify({ questions: [question] }) } }
const result = (isError, text) => ({ seq: 4, type: 'tool/result', data: { message: { content: [
  { type: 'tool-result', toolCallId: 'call-question', isError, content: [{ type: 'text', text }] },
] } } })
const user = (kind, text = 'B') => ({ seq: 5, type: 'user/message', data: { source: kind === 'plugin' ? { kind, plugin: 'dsh-keep-going' } : { kind }, content: [{ type: 'text', text }] } })

test('unanswered original questions are retained without creating a new one', () => {
  assert.deepEqual(outstandingWaits([call]), [{ kind: 'question', id: 'call-question', seq: 3, questions: [question] }])
})
test('synthetic interrupted tool failures are never mistaken for a human answer', () => {
  for (const code of ['TOOL_OUTCOME_UNKNOWN', 'TOOL_NOT_STARTED', 'Aborted']) {
    assert.equal(outstandingWaits([call, result(true, code)]).length, 1)
  }
})
test('goal rounds and plugin continue messages cannot answer the question', () => {
  for (const kind of ['plugin', 'goal']) assert.equal(outstandingWaits([call, user(kind)]).length, 1)
})
test('a genuine matching answer or a later direct human reply unblocks', () => {
  assert.equal(outstandingWaits([call, result(false, JSON.stringify({ answers: [{ id: 'choice', selected: ['B'] }] }))]).length, 0)
  assert.equal(outstandingWaits([call, user('user')]).length, 0)
})
test('incomplete or unrelated answers do not clear the request', () => {
  assert.equal(outstandingWaits([call, result(false, JSON.stringify({ answers: [{ id: 'wrong', selected: [] }] }))]).length, 1)
  assert.equal(outstandingWaits([call, result(false, 'not JSON')]).length, 1)
})
test('copied question history does not become the fork new pending question', () => {
  assert.deepEqual(outstandingWaits([call], 4), [])
})
test('an approval grant without a successful tool result is never replayed as permission', () => {
  const asked = { seq: 3, type: 'approval/asked', data: { id: 'approval-1', toolName: 'publish', callId: 'publish-1', reason: 'Publish?' } }
  const grant = { seq: 4, type: 'approval/decided', data: { id: 'approval-1', outcome: 'allowed-once' } }
  const ordinaryMessage = user('user')
  assert.equal(outstandingWaits([asked, grant, ordinaryMessage]).length, 1)
})
