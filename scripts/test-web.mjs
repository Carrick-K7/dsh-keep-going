// Mandatory cold-recovery acceptance against an installed, version-matched CLI.
// The fixture owns its temporary home/workspace, binds a random loopback port,
// and disables outbound network. It never connects to the live GUI or providers.
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const resolver = process.env.DSH_NATIVE_TEST_RESOLVE_FROM
  || fileURLToPath(new URL('../node_modules/.pnpm/fixture.cjs', import.meta.url))
const require = createRequire(resolver)
const bin = process.env.DSH_WEB_TEST_BIN || require.resolve('@deepseek-ai/dsh/lib/bin.js')
const result = spawnSync(process.execPath, [
  '--import', fileURLToPath(new URL('../test/resolve-native.mjs', import.meta.url)),
  '--test', fileURLToPath(new URL('../test/full-web-process.test.js', import.meta.url)),
], {
  stdio: 'inherit',
  env: { ...process.env, DSH_NATIVE_TEST_RESOLVE_FROM: resolver, DSH_WEB_TEST_BIN: bin },
})
if (result.error) throw result.error
process.exitCode = result.status ?? 1
