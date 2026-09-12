import { readdirSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
if (pkg.private !== true) throw new Error('This project is GitHub-only; npm publication must remain disabled')
for (const dir of ['lib', 'test', 'scripts']) {
  for (const name of readdirSync(dir).filter(n => /\.(js|mjs)$/.test(n))) {
    const result = spawnSync(process.execPath, ['--check', join(dir, name)], { stdio: 'inherit' })
    if (result.status !== 0) process.exit(result.status ?? 1)
  }
}
console.log('Syntax checks passed; npm publication is disabled.')
