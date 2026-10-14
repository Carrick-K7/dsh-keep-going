import assert from 'node:assert/strict'
import test from 'node:test'
import { createRecoveryMessage, isRecoveryMessage } from '../lib/messages.js'
import { isRecoveryMessage as policyIsRecoveryMessage } from '../lib/recovery-policy.js'

test('recovery factory preserves identity and emits only the DSH 0.2 source kind', () => {
  assert.deepEqual(createRecoveryMessage('stable-recovery-id', 'Continue exactly this task'), {
    id: 'stable-recovery-id', role: 'user',
    content: [{ type: 'text', text: 'Continue exactly this task' }],
    source: { kind: 'dsh-keep-going', form: 'instructions' },
  })
  assert.equal(policyIsRecoveryMessage, isRecoveryMessage, 'existing policy imports remain compatible')
})

test('recovery recognition accepts current, legacy and migrated provenance only', () => {
  for (const source of [
    { kind: 'dsh-keep-going', form: 'instructions' },
    { kind: 'plugin', plugin: 'dsh-keep-going', form: 'instructions' },
    { kind: 'plugin:dsh-keep-going', form: 'instructions' },
  ]) assert.equal(isRecoveryMessage({ source }), true)
  for (const message of [undefined, null, {}, { id: 'keep-going-spoof' },
    { source: { kind: 'user' } }, { source: { kind: 'goal' } },
    { source: { kind: 'plugin' } }, { source: { kind: 'plugin', plugin: 'other' } },
    { source: { kind: 'plugin:other', plugin: 'dsh-keep-going' } },
  ]) assert.equal(isRecoveryMessage(message), false)
})
