/**
 * Real ask_user_question pipeline + native durable Session/Agent/Goal effects.
 * DSH_NATIVE_TEST_RESOLVE_FROM=/opt/deepseek-harness/node_modules/.pnpm/fixture.cjs \
 *   node --import ./test/resolve-native.mjs --test test/waiting-native.test.js
 * Only the LLM and local human answerer are fixtures. No browser, modal replay,
 * channel send, Feishu delivery, live goal, credentials, or external tool effects.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createRecovery } from '../lib/recovery.js'
import { createStore } from '../lib/store.js'
import {
  createModuleLoader, createNativeKernel, NATIVE_PACKAGES, NATIVE_QUESTION_PACKAGES, waitForAbort,
} from './native-kernel.mjs'

const resolver = process.env.DSH_NATIVE_TEST_RESOLVE_FROM
const loadModule = createModuleLoader(resolver ?? new URL('../package.json', import.meta.url))
let unavailable, createNativeAdapter
try { await Promise.all([...NATIVE_PACKAGES, ...NATIVE_QUESTION_PACKAGES].map(loadModule)) }
catch (error) {
  if (resolver) throw error
  unavailable = 'Native DSH interaction dependencies unavailable; set DSH_NATIVE_TEST_RESOLVE_FROM'
}
if (!unavailable) ({ createNativeAdapter } = await import('../lib/native.js'))
const options = { skip: unavailable, timeout: 15000 }
const question = {
  id: 'original-format-question', header: 'Output format',
  question: 'Which format should the unfinished task produce?',
  options: [{ label: 'JSON', description: 'A machine-readable report.' }, { label: 'CSV', description: 'A spreadsheet report.' }],
  multi_select: false,
}
const answer = { answers: [{ id: question.id, selected: ['JSON'] }] }
const humanReply = 'My explicit answer to the original format question is JSON. Continue this task.'

function askChunks(callId) {
  const args = JSON.stringify({ questions: [question] })
  return { chunks: [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name: 'ask_user_question', argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: 'ask_user_question', arguments: args } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ] }
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'keep-going-waiting-'))
  const runs = []
  t.after(async () => {
    try {
      for (const run of runs.toReversed()) { run.recovery.stop(); await run.k.close() }
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  const store = createStore(join(root, 'recovery'))
  const boot = async (extra = {}) => {
    const k = await createNativeKernel({ root, loadModule, userQuestions: true, ...extra })
    const adapter = createNativeAdapter(k.ctx)
    const diagnostics = []
    const recovery = createRecovery({ adapter, store,
      config: { retryMinMs: 1, retryMaxMs: 10 },
      log: { log: (message) => diagnostics.push(message), error: (message) => diagnostics.push(message) },
    })
    const run = { k, adapter, recovery, diagnostics }
    runs.push(run)
    return run
  }
  return { boot, store }
}

async function enteredBeforeIdle(barrier, agent, k) {
  await Promise.race([
    barrier.promise,
    agent.whenIdle().then(() => {
      throw new Error(`Expected a pending native interaction before idle: ${JSON.stringify({ errors: k.errors, ends: k.turnEnds })}`)
    }),
  ])
}

async function cycle(run, rounds = 3) {
  for (let i = 0; i < rounds; i++) {
    await run.recovery.tick()
    await new Promise((resolve) => setImmediate(resolve))
    for (const agent of run.k.ctx.agents.list()) { await agent.whenIdle(); await run.k.flush(agent) }
  }
  await run.recovery.tick()
}

function calls(events) { return events.filter((event) => event.type === 'tool/call' && event.data.name === 'ask_user_question') }
function results(events, callId) {
  return events.filter((event) => event.type === 'tool/result')
    .flatMap((event) => event.data.message.content)
    .filter((block) => block.type === 'tool-result' && block.toolCallId === callId)
}

for (const activeGoal of [true, false]) {
  test(`native unanswered question keeps ${activeGoal ? 'active goal disarmed' : 'ordinary task waiting'} until a same-session human reply`, options, async (t) => {
    const { boot, store } = await fixture(t)
    const id = `session-native-waiting-${activeGoal ? 'goal' : 'task'}`
    const callId = `native-question-call-${id}`
    const entered = Promise.withResolvers()
    const first = await boot({ goalRounds: false, response: () => askChunks(callId) })
    const firstQuestions = []
    first.k.ctx.on('user-questions/request', async (request) => {
      firstQuestions.push({ agentId: request.agent.id, questions: request.questions })
      entered.resolve()
      return waitForAbort(request.signal)
    })
    const original = await first.k.create(id)
    const originalGoal = activeGoal
      ? first.k.ctx.goals.create(original, { objective: 'Finish only after the human chooses the report format.', maxGoalRounds: 3 })
      : undefined
    original.followup(first.k.message('Ask me which output format to use before finishing this original task.'))
    await enteredBeforeIdle(entered, original, first.k)
    await first.k.flush(original)
    assert.equal(original.status, 'running')
    assert.equal(firstQuestions.length, 1, 'the actual native tool reached its human-answer waterfall')
    assert.equal(firstQuestions[0].agentId, id)
    assert.deepEqual(firstQuestions[0].questions, [{
      id: question.id, header: question.header, question: question.question,
      options: question.options, multiSelect: false,
    }])
    assert.equal(first.k.requests.length, 1)
    assert.ok(first.k.requests[0].tools.some((tool) => tool.name === 'ask_user_question'))
    const liveEvents = original.session.snapshotEvents()
    assert.equal(calls(liveEvents).length, 1)
    assert.equal(results(liveEvents, callId).length, 0, 'no human answer was invented')
    assert.equal((await first.adapter.inspect(id)).waiting.length, 1)
    first.recovery.stop()
    await first.k.close() // Complete old Cordis/Agent/service lifetime is gone.

    let questionResends = 0
    const second = await boot({
      onRequest(request, { ctx, agent }) {
        assert.equal(agent.id, id)
        assert.ok(request.messages.some((message) => message.source.kind === 'user'
          && message.content.some((block) => block.type === 'text' && block.text === humanReply)),
        'no model call may precede the fresh human reply')
        const goal = ctx.goals.get(agent)
        if (goal?.phase === 'active') ctx.goals.complete(agent, { id: goal.id, revision: goal.revision })
      },
      response: 'Finished once using the human-selected JSON format.',
    })
    second.k.ctx.on('user-questions/request', async () => { questionResends++; return answer })
    assert.equal(second.k.ctx.agents.list().length, 0, 'a new kernel starts with no live Agent or UI scope')
    const cold = await second.adapter.inspect(id)
    assert.deepEqual(cold.waiting[0].questions, [question])
    await second.recovery.discover()
    await cycle(second)
    const resumed = second.k.ctx.agents.get(id)
    assert.ok(resumed, 'the actual recovery adapter restored the same session identity')
    assert.equal(resumed.status, 'idle')
    assert.equal(second.k.requests.length, 0)
    assert.equal(second.k.outputs.length, 0)
    assert.equal(questionResends, 0, 'recovery must not re-dispatch the original human question')
    const [job] = Object.values(store.read().jobs)
    assert.equal(job.status, 'waiting-user', second.diagnostics.join('\n'))
    assert.equal(job.sessionId, id)
    assert.deepEqual(job.waiting[0].questions, [question])
    assert.deepEqual(resumed.inbox.nextTurn, [])
    assert.deepEqual(resumed.inbox.nextStep, [], 'neither CONTINUE nor a new goal round was injected')
    if (activeGoal) {
      const goal = second.k.ctx.goals.get(resumed)
      assert.equal(goal.phase, 'active')
      assert.equal(goal.id, originalGoal.id)
      assert.equal(goal.revision, originalGoal.revision)
      assert.equal(goal.activation, 'disarmed')
      assert.equal(goal.roundsStarted, 0)
    }
    const retainedCalls = calls(resumed.session.snapshotEvents())
    assert.equal(retainedCalls.length, 1)
    assert.equal(retainedCalls[0].data.callId, callId)
    assert.deepEqual(JSON.parse(retainedCalls[0].data.arguments).questions, [question])
    assert.ok(results(resumed.session.snapshotEvents(), callId).every((block) => block.isError),
      'shutdown/error tool settlement must not masquerade as an answer')

    // This is the intended public fallback: a NEW actual human message in the
    // same session, not a reconstructed modal, fabricated old tool result, or
    // generated CONTINUE prompt acting on the user's behalf.
    const replyId = `actual-human-reply-${id}`
    resumed.followup(second.k.message(humanReply, { id: replyId }))
    await resumed.whenIdle()
    await second.k.flush(resumed)
    // Production reactivates waiting work when the reply's session/event reaches
    // the plugin; this fixture invokes that same code path explicitly.
    await second.recovery.discoverSession(id)
    await cycle(second)
    assert.equal(second.k.requests.length, 1)
    assert.equal(second.k.outputs.length, 1)
    assert.equal(second.k.outputs[0].sessionId, id)
    assert.equal(second.k.outputs[0].text, 'Finished once using the human-selected JSON format.')
    assert.equal(questionResends, 0)
    assert.equal(calls(resumed.session.snapshotEvents()).length, 1, 'the archived question remains singular')
    assert.equal(resumed.session.snapshotEvents().filter((event) => event.type === 'user/message' && event.data.id === replyId).length, 1)
    assert.deepEqual((await second.adapter.inspect(id)).waiting, [])
    assert.deepEqual(store.read().jobs, {})
    if (activeGoal) assert.equal(second.k.ctx.goals.get(resumed).phase, 'complete')
    assert.equal(second.k.errors.length, 0)
  })
}

test('a real successful question answer does not falsely block interrupted active-goal recovery', options, async (t) => {
  const { boot, store } = await fixture(t)
  const id = 'session-native-question-already-answered'
  const callId = 'native-completed-question-call'
  const afterAnswer = Promise.withResolvers()
  let originalQuestions = 0
  const first = await boot({
    goalRounds: false,
    onRequest: async (request, { index }) => {
      if (index === 1) { afterAnswer.resolve(); await waitForAbort(request.signal) }
    },
    response: () => askChunks(callId),
  })
  first.k.ctx.on('user-questions/request', async (request) => {
    assert.equal(request.agent.id, id)
    originalQuestions++
    return answer // Deterministic local HUMAN-answer fixture, through the real service.
  })
  const original = await first.k.create(id)
  first.k.ctx.goals.create(original, { objective: 'Ask the format, then finish the report.', maxGoalRounds: 3 })
  original.followup(first.k.message('Complete my report, first asking which format I want.'))
  await enteredBeforeIdle(afterAnswer, original, first.k)
  await first.k.flush(original)
  assert.equal(originalQuestions, 1)
  assert.equal(first.k.requests.length, 2, 'the answer already reached the next native model request')
  const [settled] = results(original.session.snapshotEvents(), callId)
  assert.equal(settled.isError, false)
  assert.deepEqual(JSON.parse(settled.content.filter((block) => block.type === 'text').map((block) => block.text).join('')), answer)
  assert.deepEqual((await first.adapter.inspect(id)).waiting, [])
  first.recovery.stop()
  await first.k.close()

  let questionResends = 0
  const second = await boot({
    onRequest(_request, { ctx, agent }) {
      const goal = ctx.goals.get(agent)
      assert.equal(goal.phase, 'active')
      ctx.goals.complete(agent, { id: goal.id, revision: goal.revision })
    },
    response: 'Finished with the previously answered JSON choice.',
  })
  second.k.ctx.on('user-questions/request', async () => { questionResends++; return answer })
  assert.equal(second.k.ctx.agents.list().length, 0)
  assert.deepEqual((await second.adapter.inspect(id)).waiting, [])
  await second.recovery.discover()
  await cycle(second, 5)
  assert.equal(second.k.requests.length, 1, second.diagnostics.join('\n'))
  assert.equal(second.k.outputs.length, 1)
  assert.equal(questionResends, 0)
  assert.equal(second.k.ctx.goals.get(second.k.ctx.agents.get(id)).phase, 'complete')
  assert.deepEqual((await second.adapter.inspect(id)).waiting, [])
  assert.deepEqual(store.read().jobs, {})
  const oldAnswer = second.k.requests[0].messages.flatMap((message) => message.content)
    .find((block) => block.type === 'tool-result' && block.toolCallId === callId)
  assert.equal(oldAnswer.isError, false)
  assert.deepEqual(JSON.parse(oldAnswer.content.filter((block) => block.type === 'text').map((block) => block.text).join('')), answer)
  assert.equal(second.k.errors.length, 0)
})
