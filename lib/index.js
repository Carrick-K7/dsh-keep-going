/**
 * dsh-keep-going — restart DSH without losing the task in flight.
 *
 * Contract with the deployment: a supervisor (systemd `Restart=always`, a
 * Windows service, …) restarts the process when it exits. This plugin only
 * decides *when* the exit is safe and *what* the next process should resume:
 *
 *   1. a tool or command arms a restart/shutdown,
 *   2. the plugin waits for in-flight turns (stuck ones excluded) and then
 *      requests a clean exit through `ctx.appExit`,
 *   3. the marker written before exiting names the session(s) to wake,
 *   4. the next boot reads that marker, waits for the session to come back and
 *      steers it with the continue prompt.
 *
 * It owns no process supervision (the supervisor does), no plugin rollback and
 * no browser half: the whole surface is host-side tools, commands and settings.
 * @module dsh-keep-going
 */
import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_CONTINUE_PROMPT,
  actionLabel,
  continueMessage,
  dedupe,
  drainDecision,
  partitionRunning,
} from './policy.js'
import { consumeMarker, recordExit, writeMarker } from './state.js'

/** Cordis plugin name; also the settings namespace and the marker directory. */
export const name = 'keep-going'

/** Host services this plugin needs before {@link apply} runs. */
export const inject = ['agents', 'tools', 'commands']

/** Schemastery schema for the `dsh-keep-going` settings section. */
export const Config = z.object({
  continuePrompt: z.string().default(DEFAULT_CONTINUE_PROMPT),
  drainTimeoutMs: z.number().min(1000).default(600000),
  stuckAgentMs: z.number().min(0).default(60000),
  stormLimit: z.number().min(1).default(5),
  stormWindowMs: z.number().min(1000).default(300000),
})

/** Settings namespace shown in the GUI and written by `settings.yaml`. */
export const SETTINGS_NAMESPACE = 'dsh-keep-going'

/** Fallback defaults, mirroring {@link Config} for plain-object configs. */
const DEFAULTS = Object.freeze({
  continuePrompt: DEFAULT_CONTINUE_PROMPT,
  drainTimeoutMs: 600000,
  stuckAgentMs: 60000,
  stormLimit: 5,
  stormWindowMs: 300000,
})

/** Delay between the tool's answer and the process exit, so the answer flushes. */
const EXIT_DELAY_MS = 1000

/**
 * Apply the plugin: resume a pending wake, then expose the restart surface.
 *
 * Every surface is registered inside its own guard: a plugin that breaks the
 * boot would also break the resume it exists to provide (the harness fails
 * loud and exits), so an unavailable optional service must degrade this plugin
 * instead of the host.
 * @param ctx - Cordis context carrying `agents`, `tools` and `commands`.
 * @param config - Deployment-provided configuration (schema-validated).
 */
export function apply(ctx, config = {}) {
  const initial = resolveConfig(config)
  let current = initial
  /** Latest resolved settings; the section's source is re-read on change. */
  const settings = () => current

  guard('settings', () => installSettings(ctx, settings, (next) => { current = next }))

  const activity = new Map()
  guard('activity tracking', () => trackActivity(ctx, activity))

  const runtime = {
    ctx,
    activity,
    action: null,
    owner: null,
    prompt: undefined,
    armed: false,
    ticker: null,
  }

  // The wake is the point of the plugin: load it before the optional surfaces.
  guard('resume', () => resumePending(ctx, settings()))

  guard('commands', () => registerCommands(ctx, runtime, settings))
  guard('tools', () => registerTools(ctx, runtime, settings))
}

/**
 * Run one setup step, turning any failure into a log line.
 *
 * Cordis throws when a service is read without being declared in `inject`;
 * letting that escape `apply` fails the whole loader entry and takes the host
 * process down with it.
 * @param what - Name used in the log line.
 * @param fn - Setup step to run.
 * @returns Whether the step completed.
 */
function guard(what, fn) {
  try {
    fn()
    return true
  } catch (error) {
    console.error('[keep-going] ' + what + ' unavailable:', error)
    return false
  }
}

/**
 * Apply schema defaults to a raw configuration object.
 *
 * `z.object(...)` instances are callable in Schemastery 3, but a resolved
 * settings source may already hand back a plain object — both are accepted.
 * @param raw - Deployment-provided configuration.
 * @returns A complete configuration object.
 */
function resolveConfig(raw) {
  const value = raw && typeof raw === 'object' ? raw : {}
  try {
    const parsed = typeof Config === 'function' ? Config(value) : value
    return { ...DEFAULTS, ...(parsed && typeof parsed === 'object' ? parsed : {}) }
  } catch {
    return { ...DEFAULTS, ...value }
  }
}

/**
 * Register the settings section when the running harness supports it.
 * @param ctx - Cordis context.
 * @param read - Returns the currently resolved configuration.
 * @param write - Receives a newly resolved configuration.
 */
function installSettings(ctx, read, write) {
  ctx.inject(['settings'], (sctx) => {
    const settings = sctx.settings
    if (settings === undefined || typeof settings.installSection !== 'function') return
    try {
      settings.installSection(ctx, SETTINGS_NAMESPACE, Config, read(), {
        setSource: (get) => { write({ ...Config(get()) }) },
        onChange: (next) => { write({ ...Config(next) }) },
      })
    } catch (error) {
      console.error('[keep-going] settings install failed:', error)
    }
  })
}

/**
 * Track per-session activity so stuck turns can be told apart from live ones.
 * @param ctx - Cordis context.
 * @param activity - Session id to last-activity epoch-ms.
 */
function trackActivity(ctx, activity) {
  ctx.effect(() => ctx.on('agent/status', (payload) => {
    const id = payload?.agent?.id
    if (typeof id === 'string') activity.set(id, Date.now())
  }), 'dsh-keep-going: agent status activity')
  ctx.effect(() => ctx.on('session/event', (session) => {
    if (session && typeof session.id === 'string') activity.set(session.id, Date.now())
  }), 'dsh-keep-going: session event activity')
}

/**
 * Wake the sessions named by the previous process's marker.
 *
 * Delivery is retried on `agent/session-start` and by a bounded poll, because a
 * session may be restored lazily — after the client reconnects — and may
 * therefore be missing while `apply` runs.
 * @param ctx - Cordis context.
 * @param config - Resolved configuration.
 */
function resumePending(ctx, config) {
  const marker = consumeMarker(process.env)
  if (marker === null || !marker.wake) return
  const pending = new Set(marker.sessionIds)
  const text = continueMessage(marker.prompt || config.continuePrompt)
  const started = Date.now()
  const timer = setInterval(() => deliver(), 500)
  timer.unref?.()

  const deliver = () => {
    for (const id of [...pending]) {
      const agent = ctx.agents.get(id)
      if (agent === undefined) continue
      try {
        agent.steer(buildContinueMessage(text))
        pending.delete(id)
        console.log('[keep-going] resumed session', id)
      } catch (error) {
        console.error('[keep-going] resume failed for', id, error)
        pending.delete(id)
      }
    }
    if (pending.size === 0) {
      clearInterval(timer)
      clearTimeout(giveUp)
    }
  }

  ctx.effect(() => ctx.on('agent/session-start', deliver), 'dsh-keep-going: resume on session start')
  ctx.effect(() => () => clearInterval(timer))
  const giveUp = setTimeout(() => {
    clearInterval(timer)
    if (pending.size > 0) {
      console.log('[keep-going] resume gave up after ' + Math.round((Date.now() - started) / 1000)
        + 's for: ' + [...pending].join(', '))
    }
  }, 120000)
  giveUp.unref?.()
  ctx.effect(() => () => clearTimeout(giveUp))
  deliver()
}

/**
 * Build the steering message handed to a resumed session.
 * @param text - Continue prompt.
 * @returns A frozen user-role message owned by this plugin.
 */
function buildContinueMessage(text) {
  return Object.freeze({
    id: `msg-${randomUUID()}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'dsh-keep-going', form: 'instructions' },
  })
}

/**
 * Register `/restart` and `/shutdown`.
 * @param ctx - Cordis context.
 * @param runtime - Mutable per-apply state.
 * @param settings - Resolved-config accessor.
 */
function registerCommands(ctx, runtime, settings) {
  ctx.commands.register({
    name: 'restart',
    description: '重启 DSH：等当前轮次结束后退出，由服务管理器拉起新进程并续跑未完成的任务',
    recordInput: false,
    handler() {
      const result = arm(runtime, settings, 'restart', null, undefined)
      if (!result.ok) return { kind: 'error', text: result.message }
      return { kind: 'success', text: '重启已安排：等当前轮次结束后进程退出，新进程起来后会唤醒本会话继续未完成的工作。' }
    },
  })
  ctx.commands.register({
    name: 'shutdown',
    description: '关闭 DSH：等当前轮次结束后退出，不重启',
    recordInput: false,
    handler() {
      const result = arm(runtime, settings, 'shutdown', null, undefined)
      if (!result.ok) return { kind: 'error', text: result.message }
      return { kind: 'success', text: '关闭已安排：等当前轮次结束后进程退出（不重启）。' }
    },
  })
}

/**
 * Register the model-facing tools.
 * @param ctx - Cordis context.
 * @param runtime - Mutable per-apply state.
 * @param settings - Resolved-config accessor.
 */
function registerTools(ctx, runtime, settings) {
  ctx.effect(() => ctx.tools.register({
    name: 'restart_harness',
    description: '重启 DSH 进程：等当前轮次结束后干净退出，由服务管理器拉起新进程，'
      + '并在新进程起来后自动唤醒本会话继续未完成的工作（重启不打断任务）。'
      + '返回安排结果；触发后当前会话连接会短暂中断。',
    parameters: {
      type: 'object',
      properties: {
        continuePrompt: {
          type: 'string',
          description: '可选：重启后唤醒本会话时使用的继续提示（不传则用 settings.yaml 的 dsh-keep-going.continuePrompt）。',
        },
        waitMs: {
          type: 'number',
          description: '可选：本次重启等待轮次结束的上限（毫秒，覆盖 drainTimeoutMs）。',
        },
        force: {
          type: 'boolean',
          description: '可选：即使其它会话正在跑轮次也强制安排重启。默认 false——此时会被拒绝并返回在飞会话列表，'
            + '以免打断别人的工作。仅在确认可以中断时使用。',
        },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: value?.message ?? JSON.stringify(value) }],
    },
    execute(args, exec) {
      const owner = exec?.agent?.id ?? null
      const result = arm(runtime, settings, 'restart', owner, args)
      return result.ok
        ? { ok: true, message: result.message }
        : { ok: false, message: result.message, inFlight: result.inFlight }
    },
  }), 'dsh-keep-going: restart_harness tool')

  ctx.effect(() => ctx.tools.register({
    name: 'shutdown_harness',
    description: '关闭 DSH 进程：等当前轮次结束后干净退出，不重启。触发后网页将无法访问，需要手动重新启动。',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: value?.message ?? JSON.stringify(value) }],
    },
    execute(_args, exec) {
      const owner = exec?.agent?.id ?? null
      const result = arm(runtime, settings, 'shutdown', owner, _args)
      return result.ok ? { ok: true, message: result.message } : { ok: false, message: result.message, inFlight: result.inFlight }
    },
  }), 'dsh-keep-going: shutdown_harness tool')

  ctx.effect(() => ctx.tools.register({
    name: 'cancel_harness_action',
    description: '撤销已安排但尚未执行的重启或关闭（进程退出前可调用）。只有发起该安排的会话可以撤销。',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: value?.message ?? JSON.stringify(value) }],
    },
    execute(_args, exec) {
      const caller = exec?.agent?.id ?? null
      const result = disarm(runtime, caller)
      return { ok: result.ok, message: result.message }
    },
  }), 'dsh-keep-going: cancel_harness_action tool')
}

/**
 * Arm a restart or shutdown, refusing while another session is mid-turn.
 * @param runtime - Mutable per-apply state.
 * @param settings - Resolved-config accessor.
 * @param action - `'restart'` or `'shutdown'`.
 * @param owner - Session that asked, or `null` for a user command.
 * @param args - Tool arguments (`continuePrompt`, `waitMs`).
 * @returns `{ok: true, message}` or `{ok: false, message, inFlight}`.
 */
function arm(runtime, settings, action, owner, args) {
  if (runtime.armed) {
    return { ok: false, message: '已有正在执行的重启/关闭安排，进程即将退出，无需重复触发。' }
  }
  const config = settings()
  const now = Date.now()
  const { live } = partitionRunning(runtime.ctx.agents.list(), runtime.activity, now, config.stuckAgentMs)
  const others = live.filter((agent) => agent.id !== owner)
  const force = args?.force === true
  if (others.length > 0 && !force) {
    return {
      ok: false,
      inFlight: others.map((agent) => ({ id: agent.id, status: agent.status })),
      message: `拒绝${actionLabel(action)}：另有 ${others.length} 个会话正在跑轮次（`
        + others.map((agent) => String(agent.id).slice(0, 8)).join(', ')
        + '）。等它们结束再试、让那些会话自己发起，或在确认可以中断后带 force: true 重试。',
    }
  }
  if (others.length > 0) {
    console.log('[keep-going] forced ' + action + ' while ' + others.length + ' other session(s) were mid-turn')
  }
  runtime.action = action
  runtime.owner = owner
  runtime.prompt = typeof args?.continuePrompt === 'string' && args.continuePrompt.trim() !== ''
    ? args.continuePrompt.trim()
    : undefined
  const waitMs = typeof args?.waitMs === 'number' && Number.isFinite(args.waitMs) && args.waitMs >= 1000
    ? args.waitMs
    : config.drainTimeoutMs
  scheduleExit(runtime, settings, waitMs)
  const label = actionLabel(action)
  return {
    ok: true,
    message: action === 'restart'
      ? `${label}已安排：等当前轮次结束后进程退出，新进程起来后会唤醒本会话继续未完成的工作。`
      : `${label}已安排：等当前轮次结束后进程退出（不重启）。`,
  }
}

/**
 * Cancel an armed action; only its owner (or a user command) may do so.
 * @param runtime - Mutable per-apply state.
 * @param caller - Session asking to cancel, or `null` for a user command.
 * @returns `{ok, message}`.
 */
function disarm(runtime, caller) {
  if (runtime.action === null) return { ok: true, message: '当前没有待执行的重启/关闭安排。' }
  if (runtime.armed) return { ok: false, message: '退出流程已触发，无法撤销。' }
  if (runtime.owner !== null && caller !== null && caller !== runtime.owner) {
    return { ok: false, message: '该安排由另一个会话发起，只有发起者可以撤销。' }
  }
  const label = actionLabel(runtime.action)
  runtime.action = null
  runtime.owner = null
  runtime.prompt = undefined
  runtime.armed = false
  if (runtime.ticker !== null) clearInterval(runtime.ticker)
  runtime.ticker = null
  console.log('[keep-going] ' + label + ' cancelled' + (caller === null ? '' : ' by ' + caller))
  return { ok: true, message: `已撤销${label}安排，进程将继续运行。` }
}

/**
 * Wait for in-flight turns, then exit.
 * @param runtime - Mutable per-apply state.
 * @param settings - Resolved-config accessor.
 * @param waitMs - Drain deadline in ms.
 */
function scheduleExit(runtime, settings, waitMs) {
  const deadline = Date.now() + waitMs
  const check = () => {
    if (runtime.action === null || runtime.armed) return
    const config = settings()
    const now = Date.now()
    const { live, stale } = partitionRunning(runtime.ctx.agents.list(), runtime.activity, now, config.stuckAgentMs)
    const verdict = drainDecision({ live: live.length, deadlineReached: now >= deadline })
    if (verdict === 'wait') return
    const forced = live.length > 0
    console.log('[keep-going] ' + actionLabel(runtime.action) + ' proceeding'
      + (forced ? ` after drain deadline with ${live.length} turn(s) still running` : ' with all turns idle')
      + (stale.length > 0 ? `; ${stale.length} stuck session(s) skipped` : ''))
    exit(runtime, settings, now)
  }
  runtime.ticker = setInterval(check, 500)
  runtime.ticker.unref?.()
  runtime.ctx.effect(() => () => clearInterval(runtime.ticker))
  check()
}

/**
 * Persist the marker and request a clean exit.
 * @param runtime - Mutable per-apply state.
 * @param settings - Resolved-config accessor.
 * @param now - Current epoch-ms.
 */
function exit(runtime, settings, now) {
  if (runtime.armed) return
  runtime.armed = true
  clearInterval(runtime.ticker)
  runtime.ticker = null
  const config = settings()
  const sessionIds = runtime.action === 'restart'
    ? dedupe([runtime.owner, ...runtime.ctx.agents.roots().map((agent) => agent.id)])
    : []
  try {
    // The exit history is recorded first so a crash during the exit still
    // counts towards the storm guard on the next boot.
    const storm = recordExit(process.env, config.stormLimit, config.stormWindowMs, now)
    writeMarker({
      env: process.env,
      action: runtime.action,
      now,
      wake: runtime.action === 'restart' && storm.allowWake,
      sessionIds,
      prompt: runtime.prompt,
      exits: storm.history,
    })
    if (!storm.allowWake) {
      console.log('[keep-going] restart storm guard: ' + storm.count + ' exits inside the window; wake suppressed')
    }
  } catch (error) {
    console.error('[keep-going] failed to write the restart marker:', error)
  }
  const appExit = typeof runtime.ctx.get === 'function' ? runtime.ctx.get('appExit') : undefined
  setTimeout(() => {
    if (typeof appExit === 'function') {
      console.log('[keep-going] requesting clean exit')
      appExit(0)
    } else {
      console.log('[keep-going] appExit unavailable; falling back to process.exit(0)')
      process.exit(0)
    }
  }, EXIT_DELAY_MS).unref?.()
}
