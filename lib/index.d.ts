/**
 * Type surface of dsh-keep-going.
 *
 * The plugin is host-only: it contributes model-facing tools, slash commands
 * and a settings section, and owns no browser half.
 */
import type { Context } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'

/** Cordis plugin name; also the settings namespace and marker directory. */
export declare const name: 'keep-going'

/** Host services required before `apply` runs. */
export declare const inject: readonly ['agents', 'tools']

/** Settings namespace shown in the GUI and written by `settings.yaml`. */
export declare const SETTINGS_NAMESPACE: 'dsh-keep-going'

/** Schemastery schema for the `dsh-keep-going` settings section. */
export declare const Config: z<ConfigValues>

/** Resolved configuration of this plugin. */
export interface ConfigValues {
  /** Woken-session prompt; `restart_harness.continuePrompt` overrides it. */
  continuePrompt: string
  /** Drain deadline in ms: exit anyway once it passes. */
  drainTimeoutMs: number
  /** Inactivity after which a `running` agent counts as stuck. */
  stuckAgentMs: number
  /** Exits allowed inside {@link ConfigValues.stormWindowMs} before waking stops. */
  stormLimit: number
  /** Rolling restart-storm window in ms. */
  stormWindowMs: number
}

/**
 * Apply the plugin: resume a pending wake, then expose the restart surface.
 * @param ctx - Cordis context carrying `agents` and `tools`.
 * @param config - Deployment-provided configuration.
 */
export declare function apply(ctx: Context, config?: Partial<ConfigValues>): void

export * from './policy.js'
