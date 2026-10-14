/** Compile-only consumer contract: plain inputs, live refs, and fixed storage. */
import type { Context, Volatile } from '@deepseek-ai/cordis'
import { Config, apply, inject, type ConfigValues, type LiveConfig, type HotConfigValues } from '../lib/index.js'

declare const ctx: Context
const live: LiveConfig = Config({ maxAttempts: 4 })
const attempts: number = live.maxAttempts.get()
const ref: Volatile<number> = live.maxAttempts
const directory: string = live.stateDirectory
apply(ctx, live)
apply(ctx, { maxAttempts: 4, stateDirectory: '' })
apply(ctx)
ctx.plugin({ Config, apply, inject }, { maxAttempts: 4 })
const hot: HotConfigValues = {} as Omit<ConfigValues, 'stateDirectory'>

// @ts-expect-error hot settings never expose the storage directory
hot.stateDirectory
// @ts-expect-error runtime values are live refs, not plain snapshots
const plain: number = live.maxAttempts
// @ts-expect-error directory must never become a volatile ref
live.stateDirectory.get()
// @ts-expect-error config input must remain numeric
Config({ maxAttempts: '4' })

// Keep positive examples meaningful under noUnusedLocals as well.
void [attempts, ref, directory, plain]
