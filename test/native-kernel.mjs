/**
 * Isolated integration-test kernel: real Cordis/DSH sessions, AgentLoop, JSONL,
 * goals and goal-round-driver; only the LLM and SessionController facade are
 * fixtures. No launcher, browser, credentials, shell, or DSH_HOME is consulted.
 *
 * Dependencies are resolved by ordinary import unless loadModule is supplied.
 * createModuleLoader('/some/install/package.json') uses that installation's
 * resolution without copying/symlinking its node_modules into this repository.
 * Match the DSH packages to 0.1.5-rc.2 and Cordis to its installed 4.x version.
 */
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const NATIVE_PACKAGES = Object.freeze([
  'cordis', 'dsh-llm', 'dsh-agent', 'dsh-session', 'dsh-session-projection',
  'dsh-system-prompt', 'dsh-tools', 'dsh-session-persistence-jsonl',
  'dsh-session-query-sqlite', 'dsh-goal', 'dsh-session-checkpoint-policy',
  'dsh-agent-loop', 'dsh-goal-round-driver', 'dsh-typert-protocol',
].map((name) => '@deepseek-ai/' + name))

/** Optional real interaction services; ordinary smoke kernels need neither. */
export const NATIVE_QUESTION_PACKAGES = Object.freeze([
  '@deepseek-ai/dsh-user-questions', '@deepseek-ai/dsh-tool-ask-user',
])

/** The resolution anchor is a caller-selected absolute filename or file URL. */
export function createModuleLoader(resolutionBase) {
  const require = createRequire(resolutionBase)
  return (specifier) => import(pathToFileURL(require.resolve(specifier)).href)
}

/** A controllable test barrier which rejects promptly on Agent cancellation. */
export function waitForAbort(signal) {
  if (!signal) return Promise.reject(new TypeError('A cancellation signal is required'))
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

/**
 * @param {object} options
 * @param {string} options.root Absolute fixture directory, retained across boots.
 * @param {Function} [options.loadModule] Async importer accepting full package names.
 * @param {Function} [options.onRequest] Awaited (request, {ctx, agent, index}); must honor request.signal.
 * @param {string|object|Function} [options.response] Text, {text, finish}, or {chunks: Iterable|AsyncIterable} (complete native stream), optionally returned by async (request, context).
 * @param {boolean} [options.goalRounds=true] Mount the real automatic goal driver.
 * @param {boolean} [options.userQuestions=false] Mount real userQuestions and ask_user_question; tests supply the local answerer.
 * @returns {Promise<object>} Native services, owned create/restore, lifecycle, and real log recordings.
 */
export async function createNativeKernel({
  root,
  loadModule = (specifier) => import(specifier),
  onRequest,
  response = 'fixture-ok',
  goalRounds = true,
  userQuestions = false,
} = {}) {
  if (typeof root !== 'string' || !isAbsolute(root)) {
    throw new TypeError('createNativeKernel requires an explicit absolute fixture root')
  }
  const packages = userQuestions ? [...NATIVE_PACKAGES, ...NATIVE_QUESTION_PACKAGES] : NATIVE_PACKAGES
  const modules = new Map(await Promise.all(packages.map(async (name) => {
    try {
      return [name.slice('@deepseek-ai/'.length), await loadModule(name)]
    } catch (cause) {
      throw new Error(`Native kernel cannot load ${name}; provide loadModule or local test dependencies`, { cause })
    }
  })))
  const { Context } = modules.get('cordis')
  const { LlmAdapter, createUserMessage, freezeMessage, MessageId } = modules.get('dsh-llm')
  const { SessionId } = modules.get('dsh-session')
  const { RemoteError } = modules.get('dsh-typert-protocol')
  const ctx = new Context()
  const cwd = join(root, 'workspace')
  const persistenceRoot = join(root, 'sessions')
  await mkdir(cwd, { recursive: true })
  const requests = []
  const outputs = []
  const events = []
  const turnEnds = []
  const errors = []
  const handles = new Map()
  const pending = new Map()
  let closing = false
  let closePromise

  class FakeLlm extends LlmAdapter {
    async *stream(request) {
      request.signal?.throwIfAborted()
      const context = {
        ctx,
        agent: ctx.agents.get(request.sessionId),
        index: requests.length,
      }
      // Keep the actual immutable native request, including its cancellation signal.
      requests.push(request)
      await onRequest?.(request, context)
      request.signal?.throwIfAborted()
      const value = typeof response === 'function' ? await response(request, context) : response
      request.signal?.throwIfAborted()
      const result = typeof value === 'string' ? { text: value } : value
      if (result?.chunks !== undefined) {
        // Adapters, not the helper, own block assembly and terminal finish.
        // No session/tool events are fabricated: the actual AgentLoop logs them.
        for await (const chunk of result.chunks) {
          request.signal?.throwIfAborted()
          yield chunk
        }
        return
      }
      if (!result || typeof result.text !== 'string') throw new TypeError('Fake response must contain text or chunks')
      const reason = typeof result.finish === 'object'
        ? result.finish
        : { kind: result.finish ?? 'stop' }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: result.text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: result.text } }
      yield { type: 'finish', reason }
    }
  }

  const mount = async (name, config = {}) => {
    const mod = modules.get(name)
    return ctx.plugin(mod.default ?? mod, config)
  }
  const agentOptions = { provider: 'fixture', model: 'deterministic' }

  /** Both operations use real factory-owned handles; concurrent resumes share one. */
  function obtain(id, options, resume) {
    if (closing) return Promise.reject(new Error('Native kernel is closing'))
    const sessionId = SessionId(id)
    const live = ctx.agents.get(sessionId)
    if (live) {
      if (resume) return Promise.resolve(live)
      return Promise.reject(new Error(`Agent ${id} already exists`))
    }
    const key = (resume ? 'resume:' : 'create:') + sessionId
    if (pending.has(key)) return pending.get(key)
    const work = (async () => {
      const common = {
        ...options,
        agentOptions: { ...agentOptions, ...options.agentOptions },
      }
      const handle = resume
        ? await ctx.agents.resume({ ...common, resumeSessionId: sessionId })
        : await ctx.agents.create({ ...common, sessionId, meta: { cwd, ...options.meta } })
      handles.set(sessionId, handle)
      return handle.agent
    })().finally(() => pending.delete(key))
    pending.set(key, work)
    return work
  }

  const create = (id, options = {}) => obtain(id, options, false)
  const restore = (id, options = {}) => obtain(id, options, true)

  // TEST FACADE ONLY: not the real API Session controller's presets, media,
  // workspace authorization, model selection, remote routes, or browser behavior.
  const sessionController = {
    fixture: 'native-agent-resume-only',
    async resolveAgent(id) {
      try {
        const observation = await ctx.sessionQuery.observeSession(SessionId(id), { projectionMode: 'none' })
        try {
          if (observation.header.origin === 'subagent') {
            return { error: new RemoteError('session/agent-busy', 'Fixture excludes subagents', {}) }
          }
          if (observation.header.cwd === undefined) {
            return { error: new RemoteError('session/not-found', 'Fixture requires a workspace', { sessionId: id }) }
          }
        } finally {
          observation[Symbol.dispose]()
        }
        return { agent: await restore(id) }
      } catch (error) {
        const code = error.code === 'SESSION_QUERY_SESSION_NOT_FOUND' ? 'session/not-found' : 'gateway/internal'
        return { error: new RemoteError(code, String(error), {}) }
      }
    },
  }

  async function close() {
    if (closePromise) return closePromise
    closing = true
    closePromise = ctx.fiber.dispose()
    return closePromise
  }

  try {
    await mount('dsh-session')
    await mount('dsh-session-projection')
    await mount('dsh-system-prompt', { includeHarnessIdentity: false, includeRuntimeContext: false })
    await mount('dsh-tools', { mode: 'native' })
    await mount('dsh-llm')
    ctx.llm.registerAdapter(['fixture'], new FakeLlm())
    await mount('dsh-agent')
    if (userQuestions) {
      await mount('dsh-user-questions')
      await mount('dsh-tool-ask-user')
    }
    await mount('dsh-session-persistence-jsonl', { root: persistenceRoot, compression: 'none' })
    await mount('dsh-session-query-sqlite', { path: ':memory:', openAt: 'never' })
    await mount('dsh-goal')
    await mount('dsh-session-checkpoint-policy')
    await mount('dsh-agent-loop', { agents: [] })
    if (goalRounds) await mount('dsh-goal-round-driver')
    ctx.provide('sessionController', sessionController)
    ctx.on('session/event', (session, event) => {
      const recorded = { sessionId: session.id, event }
      events.push(recorded)
      if (event.type === 'turn/end') turnEnds.push(recorded)
      if (event.type === 'assistant/message') {
        outputs.push({
          ...recorded,
          message: event.data.message,
          text: event.data.message.content.filter((block) => block.type === 'text').map((block) => block.text).join(''),
        })
      }
    })
    ctx.on('agent/error', (payload) => errors.push(payload))
  } catch (error) {
    await close().catch(() => {})
    throw error
  }

  return {
    ctx, root, cwd, persistenceRoot, requests, outputs, events, turnEnds, errors,
    create, restore, close, sessionController,
    /** Mint normal native input, or preserve a caller's stable recovery identity. */
    message(text, { id, source = { kind: 'user' } } = {}) {
      const content = [{ type: 'text', text }]
      return id === undefined
        ? createUserMessage({ content, source })
        : freezeMessage({ id: MessageId(id), role: 'user', content, source })
    },
    async flush(agent) {
      const participated = await ctx.sessions.flush(agent.session)
      if (!participated) throw new Error('Native fixture session has no durability listener')
    },
    async dispose(id) {
      const handle = handles.get(id)
      if (handle) await handle.dispose()
      handles.delete(id)
    },
    // Public pure folds useful to assertions without extra package resolution.
    foldConsumedWork: modules.get('dsh-agent').foldConsumedWork,
    foldGoal: modules.get('dsh-goal').foldGoal,
  }
}
