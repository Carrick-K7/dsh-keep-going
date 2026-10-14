import assert from 'node:assert/strict'
import test from 'node:test'
import { outstandingWaits } from '../lib/waiting.js'
const question = { id: 'choice', question: 'Which target should be used?', options: [{ label: 'A' }, { label: 'B' }] }
const call = { seq: 3, type: 'tool/call', data: { callId: 'call-question', name: 'ask_user_question', arguments: JSON.stringify({ questions: [question] }) } }
const answer = JSON.stringify({ answers: [{ id: 'choice', selected: ['B'] }] })
const asked = { seq: 3, type: 'approval/asked', data: { id: 'approval-1', toolName: 'publish', callId: 'call-question', reason: 'Publish?' } }
const result = (format, isError, text, error) => {
  const content = [{ type: 'text', text }]
  const source = { kind: 'tool', callId: 'call-question' }
  const message = format === 'DSH 0.2'
    ? { role: 'tool', source, toolCallId: source.callId, isError, content }
    : { role: 'user', source, content: [{ type: 'tool-result', toolCallId: source.callId, isError, content }] }
  return { seq: 4, type: 'tool/result', data: { message, ...(error ? { error } : {}) } }
}
const user = (kind, text = 'B') => ({ seq: 5, type: 'user/message', data: { source: kind === 'plugin' ? { kind, plugin: 'dsh-keep-going' } : { kind }, content: [{ type: 'text', text }] } })

test('unanswered original questions are retained without creating a new one', () => {
  assert.deepEqual(outstandingWaits([call]), [{ kind: 'question', id: 'call-question', seq: 3, questions: [question] }])
})
for (const format of ['legacy', 'DSH 0.2']) {
  test(`${format}: synthetic interrupted tool failures never answer questions or consume approvals`, () => {
    for (const code of ['TOOL_OUTCOME_UNKNOWN', 'TOOL_NOT_STARTED', 'TOOL_ABORTED_BEFORE_DISPATCH', 'Aborted']) {
      assert.equal(outstandingWaits([call, result(format, true, code)]).length, 1)
      assert.equal(outstandingWaits([asked, result(format, true, code)]).length, 1)
      // Even answer-shaped text cannot override the durable failure outcome.
      assert.equal(outstandingWaits([call, asked, result(format, true, answer, { code })]).length, 2)
      assert.equal(outstandingWaits([call, asked, result(format, undefined, answer, { code })]).length, 2)
    }
  })
  test(`${format}: a genuine matching answer unblocks the original question`, () => {
    assert.deepEqual(outstandingWaits([call, result(format, false, answer)]), [])
    // isError is optional on native ToolResultMessage.
    assert.deepEqual(outstandingWaits([call, result(format, undefined, answer)]), [])
  })
  test(`${format}: a successful matching tool settlement consumes only its approval`, () => {
    const other = { ...asked, data: { ...asked.data, id: 'other-approval', callId: 'other-call' } }
    const waits = outstandingWaits([asked, other, result(format, false, 'Published')])
    assert.equal(waits.length, 1)
    assert.equal(waits[0].id, other.data.id)
  })
  test(`${format}: incomplete or unrelated answers do not clear the request`, () => {
    for (const text of [JSON.stringify({ answers: [{ id: 'wrong', selected: [] }] }), 'not JSON']) {
      assert.equal(outstandingWaits([call, result(format, false, text)]).length, 1)
    }
    const unrelated = result(format, false, answer)
    if (format === 'DSH 0.2') unrelated.data.message.toolCallId = 'other-call'
    else unrelated.data.message.content[0].toolCallId = 'other-call'
    assert.equal(outstandingWaits([call, unrelated]).length, 1)
  })
}
test('goal rounds and all recovery source generations cannot answer the question', () => {
  for (const kind of ['plugin', 'plugin:dsh-keep-going', 'dsh-keep-going', 'goal']) {
    assert.equal(outstandingWaits([call, user(kind)]).length, 1)
  }
})
test('a later direct human reply unblocks', () => {
  assert.deepEqual(outstandingWaits([call, user('user')]), [])
})
test('copied question history does not become the fork new pending question', () => {
  assert.deepEqual(outstandingWaits([call], 4), [])
})
test('an approval grant without a successful tool result is never replayed as permission', () => {
  const grant = { seq: 4, type: 'approval/decided', data: { id: 'approval-1', outcome: 'allowed-once' } }
  assert.equal(outstandingWaits([asked, grant, user('user')]).length, 1)
})
