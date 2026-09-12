import type { Context } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'

export declare const name: 'keep-going'
export declare const SETTINGS_NAMESPACE: 'dsh-keep-going'
export declare const inject: ['agents', 'tools', 'commands', 'sessions', 'sessionQuery', 'sessionController', 'goals']
export declare const Config: z<ConfigValues>
export interface ConfigValues {
  /** Absolute path, or a path relative to DSH_HOME. Empty uses DSH_HOME/dsh-keep-going. */
  stateDirectory: string
  /** Initial waiting interval. Only force:true permits cutoff when it elapses. */
  drainTimeoutMs: number
  retryMinMs: number
  retryMaxMs: number
  /** @deprecated Ignored: recovery runs once after a restart; there is no periodic scanning. Kept only so older settings keep parsing. */
  scanIntervalMs: number
  /** A code the service manager is configured to restart. Defaults to 75. */
  restartExitCode: number
  restartBurstLimit: number
  restartWindowMs: number
}
export declare function apply(ctx: Context, config?: Partial<ConfigValues>): void
