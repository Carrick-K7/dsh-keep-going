/**
 * Unit tests for the pure policy layer — no Cordis, no DSH, no timers.
 * Run with: node --test test/
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  actionLabel,
  wakeTargets,
  buildMarker,
  continueMessage,
  dedupe,
  drainDecision,
  normalizeMarker,
  partitionRunning,
  stormDecision,
} from '../lib/policy.js'

const agent = (id, status = 'running') => ({ id, status })

test('partitionRunning separates live turns from stuck ones', () => {
  const now = 1_000_000
  const activity = new Map([['a', now - 1000], ['b', now - 120_000]])
  const { live, stale } = partitionRunning([agent('a'), agent('b'), agent('c', 'idle')], activity, now, 60_000)
  assert.deepEqual(live.map((x) => x.id), ['a'])
  assert.deepEqual(stale.map((x) => x.id), ['b'])
})

test('partitionRunning waits for an agent whose activity was never observed', () => {
  const { live, stale } = partitionRunning([agent('never-seen')], new Map(), Date.now(), 60_000)
  assert.equal(stale.length, 0, 'unknown activity must not be treated as stuck')
  assert.equal(live.length, 1)
})

test('drainDecision waits only while a live turn runs and the deadline has not passed', () => {
  assert.equal(drainDecision({ live: 1, deadlineReached: false }), 'wait')
  assert.equal(drainDecision({ live: 1, deadlineReached: true }), 'exit')
  assert.equal(drainDecision({ live: 0, deadlineReached: false }), 'exit')
})

test('stormDecision allows wakes up to the limit and prunes old exits', () => {
  const now = 1_000_000
  const first = stormDecision([], now, 2, 1000)
  assert.equal(first.allowWake, true)
  const second = stormDecision(first.history, now + 10, 2, 1000)
  assert.equal(second.allowWake, true)
  const third = stormDecision(second.history, now + 20, 2, 1000)
  assert.equal(third.allowWake, false)
  assert.equal(third.count, 3)
  const later = stormDecision(third.history, now + 5000, 2, 1000)
  assert.equal(later.allowWake, true)
  assert.equal(later.count, 1)
})

test('buildMarker carries the caller and drops sessions when waking is off', () => {
  const now = Date.UTC(2026, 8, 12, 0, 0, 0)
  const marker = buildMarker({
    action: 'restart', now, wake: true, sessionIds: ['s1', 's1', 's2'], prompt: ' go ', exits: [now],
  })
  assert.equal(marker.wake, true)
  assert.deepEqual(marker.sessionIds, ['s1', 's2'])
  assert.equal(marker.prompt, 'go')
  assert.equal(marker.at, new Date(now).toISOString())

  const quiet = buildMarker({ action: 'restart', now, wake: false, sessionIds: ['s1'] })
  assert.equal(quiet.wake, false)
  assert.deepEqual(quiet.sessionIds, [])
  assert.equal('prompt' in quiet, false)
})

test('normalizeMarker rejects junk and never wakes without targets', () => {
  assert.equal(normalizeMarker(null), null)
  assert.equal(normalizeMarker('nope'), null)
  const marker = normalizeMarker({ wake: true, sessionIds: ['', 42, 's1'] })
  assert.deepEqual(marker.sessionIds, ['s1'])
  assert.equal(marker.wake, true)
  assert.equal(normalizeMarker({ wake: true, sessionIds: [] }).wake, false)
  assert.equal(normalizeMarker({ action: 'shutdown' }).action, 'shutdown')
})

test('continueMessage falls back to the built-in prompt', () => {
  assert.equal(continueMessage(' 继续 '), '继续')
  assert.equal(continueMessage(''), continueMessage(undefined))
  assert.match(continueMessage(undefined), /重启/)
})

test('actionLabel maps both action kinds', () => {
  assert.equal(actionLabel('restart'), '重启')
  assert.equal(actionLabel('shutdown'), '关闭')
})

test('dedupe keeps first-seen order and drops non-strings', () => {
  assert.deepEqual(dedupe(['b', 'a', 'b', '', null, 'a']), ['b', 'a'])
  assert.deepEqual(dedupe(undefined), [])
})

test('wakeTargets is the caller and only the caller', () => {
  assert.deepEqual(wakeTargets('me'), ['me'])
  assert.deepEqual(wakeTargets(null), [], 'a user command wakes nobody')
  assert.deepEqual(wakeTargets(undefined), [])
})
