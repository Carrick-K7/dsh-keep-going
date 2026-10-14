import type { Context, Volatile } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'

export declare const name: 'keep-going'
/** @deprecated Legacy 0.1 settings namespace only. DSH 0.2 uses the loader entry id (normally keep-going). */
export declare const SETTINGS_NAMESPACE: 'dsh-keep-going'
export declare const inject: ['agents', 'tools', 'commands', 'sessions', 'sessionQuery', 'sessionController', 'goals', 'workspaceRegistry']
/** Plain input is validated into the runtime's stable live references. Requires DSH 0.2. */
export declare const Config: z<Partial<ConfigValues>, LiveConfig>
/** Plain snapshot used by recovery/control; read again for each subsequent operation. */
export interface ConfigValues {
  /** Absolute path, or relative to DSH_HOME. Empty uses DSH_HOME/dsh-keep-going. Non-volatile: requires plugin reload. */
  stateDirectory: string
  /** Initial waiting interval. Only force:true permits cutoff when it elapses. */
  drainTimeoutMs: number
  retryMinMs: number
  retryMaxMs: number
  /** Maximum recovery attempts, from 1 to 10. Defaults to 3. */
  maxAttempts: number
  /** @deprecated Ignored: recovery runs once after a restart; there is no periodic scanning. Kept only so older settings keep parsing. */
  scanIntervalMs: number
  /** A code the service manager is configured to restart. Defaults to 75. */
  restartExitCode: number
  restartBurstLimit: number
  restartWindowMs: number
}
/** Fields exposed by DSH 0.2 settings without remounting the plugin. */
export type HotConfigValues = Omit<ConfigValues, 'stateDirectory'>
/** Keep these references and call get() at operation time; do not cache their snapshots. */
export type LiveConfig = Pick<ConfigValues, 'stateDirectory'> & {
  [K in keyof HotConfigValues]: Volatile<HotConfigValues[K]>
}
/** Direct callers may supply plain partial values; Cordis supplies validated live config. */
export declare function apply(ctx: Context, config?: Partial<ConfigValues> | LiveConfig): void
