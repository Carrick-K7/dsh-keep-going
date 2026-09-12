/**
 * Preloaded ONLY in a test-owned real `dsh web` child, and mounted by its overlay.
 * This supplies a deterministic LLM, NOT a SessionController or Agent facade.
 */
import assert from 'node:assert/strict'
import net from 'node:net'
import { isAbsolute, join } from 'node:path'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionController } from '@deepseek-ai/dsh-api-session-controller'

const root = process.env.DSH_FULL_WEB_TEST_ROOT
const mode = process.env.DSH_FULL_WEB_TEST_MODE
if (!process.send || !root || !isAbsolute(root) || !['seed', 'recover'].includes(mode)) {
  throw new Error('full-web-fixture requires an explicitly configured test-owned IPC child')
}
assert.equal(process.env.DSH_HOME, join(root, 'home'))
// Even an abruptly lost test parent must not leave an orphan Web fixture.
process.once('disconnect', () => process.exit(1))
process.channel?.unref() // IPC must not keep a cleanly stopped CLI alive.
const outboundAttempts = []
// Installed before the CLI boots. Accepting the parent's loopback HTTP request
// does not call Socket.connect; every CHILD-initiated connection fails closed.
net.Socket.prototype.connect = function () {
  outboundAttempts.push('socket.connect')
  throw new Error('FULL_WEB_FIXTURE_OUTBOUND_NETWORK_DISABLED')
}
globalThis.fetch = async function () {
  outboundAttempts.push('fetch')
  throw new Error('FULL_WEB_FIXTURE_OUTBOUND_NETWORK_DISABLED')
}
const manifest = [
  { id: 'session-full-web-ordinary', kind: 'ordinary', provider: 'full-web-ordinary-provider', model: 'saved-ordinary-model',
    original: 'ORIGINAL_FULL_WEB_ORDINARY_4ed0: finish this unique ordinary task after restart.' },
  { id: 'session-full-web-goal', kind: 'goal', provider: 'full-web-goal-provider', model: 'saved-goal-model',
    original: 'ORIGINAL_FULL_WEB_GOAL_8c3a: finish this distinct persistent goal after restart.' },
]
const send = (payload) => new Promise((resolve, reject) => {
  if (!process.connected) return reject(new Error('Full-Web fixture parent disconnected'))
  process.send(payload, (error) => error ? reject(error) : resolve())
})
function waitForAbort(signal) {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
}
const text = (message) => message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n')

export const name = 'keep-going-full-web-fixture'
export const inject = ['llm', 'agents', 'sessions', 'sessionProjections', 'sessionQuery', 'sessionController', 'goals', 'commands', 'tools', 'webServer', 'webRuntime', 'connection', 'agentDefaultModel']
export function apply(ctx) {
  assert.ok(ctx.sessionController instanceof SessionController, 'must use the actual shipped Web SessionController')
  assert.equal(ctx.sessionController.fixture, undefined)
  const bootLive = ctx.agents.list().length
  const requests = [], outputs = [], starts = [], errors = []
  const entered = new Map(manifest.map((item) => [item.id, Promise.withResolvers()]))
  const allOutput = Promise.withResolvers()
  let reportedFailure = false
  const fail = (error) => {
    if (reportedFailure) return
    reportedFailure = true
    const jobs = ctx.get('keepGoing')?.recovery.status().pending.map((job) => ({
      kind: job.kind, sessionId: job.sessionId, status: job.status, inputId: job.inputId, workId: job.workId,
    }))
    void send({ type: 'fatal', error: error.stack || String(error), errors, outboundAttempts, jobs }).catch(() => {})
  }

  class FixtureLlm extends LlmAdapter {
    async listModels(provider) {
      const item = manifest.find((entry) => entry.provider === provider)
      return [{ id: item?.model ?? 'deliberately-different-default', name: 'Offline full-Web fixture' }]
    }
    async *stream(request) {
      try {
        request.signal.throwIfAborted()
        const item = manifest.find((entry) => entry.id === request.sessionId)
        assert.ok(item, 'no title, auxiliary, or unrelated model request is permitted')
        assert.equal(request.provider, item.provider, 'saved provider must beat the boot default')
        assert.equal(request.model, item.model, 'saved model must beat the boot default')
        requests.push({ sessionId: request.sessionId, provider: request.provider, model: request.model,
          messages: request.messages.map((message) => ({ id: message.id, source: message.source, text: text(message) })) })
        entered.get(item.id).resolve()
        if (mode === 'seed') { await waitForAbort(request.signal); return }
        const agent = ctx.agents.get(item.id)
        assert.ok(agent)
        if (item.kind === 'goal') {
          const goal = ctx.goals.get(agent)
          assert.equal(goal.phase, 'active')
          assert.equal(goal.activation, 'armed')
          ctx.goals.complete(agent, { id: goal.id, revision: goal.revision })
        }
        const answer = `FULL_WEB_RECOVERED:${item.id}`
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: answer }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } catch (error) {
        if (!request.signal.aborted) fail(error)
        throw error
      }
    }
  }
  ctx.llm.registerAdapter([...manifest.map((item) => item.provider), 'full-web-unused-default'], new FixtureLlm())
  ctx.on('agent/session-start', ({ agent, source }) => starts.push({ id: agent.id, source }))
  ctx.on('agent/error', ({ agent, error }) => {
    errors.push({ id: agent.id, error: String(error) })
    fail(error)
  })
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'assistant/message') return
    outputs.push({ sessionId: session.id, seq: event.seq, messageId: event.data.message.id, text: text(event.data.message) })
    if (manifest.every((item) => outputs.some((out) => out.sessionId === item.id))) allOutput.resolve()
  })
  // Loader rows have no load-order semantics. This service is the overlay's
  // explicit dependency gate for keep-going, after the adapter/listeners exist.
  ctx.provide('fullWebFixtureReady', true)
  ctx.inject(['keepGoing'], (scope) => {
    void (async () => {
      await scope.keepGoing.ready
      assert.equal(bootLive, 0, 'nothing cold-restored before real keep-going activation')
      if (mode === 'seed') {
        // sessionController.selectModel also persists the GLOBAL default
        // (agentDefaultModel.saveSelection). Capture the pristine boot default
        // and restore it after seeding so the recover boot can compare each
        // session's saved provider against the real default.
        const pristineDefault = scope.agentDefaultModel.currentSelection()
        for (const item of manifest) {
          const created = await scope.sessionController.create({ sessionId: item.id, cwd: join(root, 'workspace'), agentPreset: 'standard' })
          assert.equal(created.sessionId, item.id)
          await scope.sessionController.selectModel({ sessionId: item.id, provider: item.provider, model: item.model })
          await scope.sessionController.prompt({ sessionId: item.id, requestId: `original-${item.id}`, mode: 'queue',
            content: [{ type: 'text', text: item.original }] }, new AbortController().signal)
          await entered.get(item.id).promise
          const agent = scope.agents.get(item.id)
          // Creating the goal while this real request is already running avoids
          // a seed-time driver race WITHOUT disabling the shipped goal driver.
          if (item.kind === 'goal') scope.goals.create(agent, { objective: item.original, maxGoalRounds: 3 })
          assert.equal(await scope.sessions.flush(agent.session), true)
        }
        await scope.agentDefaultModel.saveSelection(pristineDefault)
        assert.equal(requests.length, manifest.length)
        await send({ type: 'seed-ready', bootLive, manifest, requests, outboundAttempts,
          origin: `http://${scope.webServer.host}:${scope.webServer.port}`,
          launchUrl: scope.connection.authenticatedUrl(`http://${scope.webServer.host}:${scope.webServer.port}`),
          controllerIsShipped: scope.sessionController instanceof SessionController,
          controllerName: scope.sessionController.constructor.name,
          defaults: pristineDefault,
          sessions: manifest.map((item) => {
            const agent = scope.agents.get(item.id)
            return { id: item.id, header: agent.session.header, status: agent.status,
              turnEnds: agent.session.snapshotEvents().filter((event) => event.type === 'turn/end').length,
              goal: scope.goals.get(agent) ?? null }
          }),
        })
        return // The parent SIGKILLs this exact child after durable request entry.
      }

      // Recovery is entirely the real keep-going startup/periodic poll. This
      // branch never invokes SessionController.create/resolveAgent or factories.
      await allOutput.promise
      for (const agent of scope.agents.list()) {
        await agent.whenIdle()
        assert.equal(await scope.sessions.flush(agent.session), true)
      }
      await scope.keepGoing.poll()
      const sessions = manifest.map((item) => {
        const agent = scope.agents.get(item.id)
        assert.ok(agent, 'real keep-going restored the original identity')
        const events = agent.session.snapshotEvents()
        return { id: item.id, header: agent.session.header, status: agent.status, goal: scope.goals.get(agent) ?? null,
          reasons: events.filter((event) => event.type === 'turn/end').map((event) => event.data.reason),
          requestConfig: agent.session.requestHeader().config,
          modelSelection: scope.sessionProjections.stateOf(agent.session, 'modelSelection'),
        }
      })
      await send({ type: 'recovered', bootLive, manifest, requests, outputs, starts, sessions, errors, outboundAttempts,
        origin: `http://${scope.webServer.host}:${scope.webServer.port}`,
        launchUrl: scope.connection.authenticatedUrl(`http://${scope.webServer.host}:${scope.webServer.port}`),
        controllerIsShipped: scope.sessionController instanceof SessionController,
        controllerName: scope.sessionController.constructor.name,
        defaults: scope.agentDefaultModel.currentSelection(),
        pendingCount: scope.keepGoing.status().pendingCount,
        storageError: scope.keepGoing.status().storageError,
        limits: ['Real CLI and shipped Web SessionController; no browser client opened.', 'No external LLM, channel, or Feishu delivery.'],
      })
    })().catch(fail)
  })
}
