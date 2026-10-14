/** Recovery provenance across current messages and older persisted sessions. */
export function createRecoveryMessage(id, text) {
  return { id, role: 'user', content: [{ type: 'text', text }],
    source: { kind: 'dsh-keep-going', form: 'instructions' } }
}

export function isRecoveryMessage(message) {
  const source = message?.source
  return source?.kind === 'dsh-keep-going' || source?.kind === 'plugin:dsh-keep-going'
    || (source?.kind === 'plugin' && source.plugin === 'dsh-keep-going')
}
