// Optional test-only resolution from an existing DSH installation. Normal CI
// installs devDependencies and does not set DSH_NATIVE_TEST_RESOLVE_FROM.
import { createRequire, registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
const base = process.env.DSH_NATIVE_TEST_RESOLVE_FROM
if (base) {
  const require = createRequire(base)
  let nested = false
  registerHooks({ resolve(specifier, context, next) {
    if (!nested && specifier.startsWith('@deepseek-ai/')) {
      nested = true
      try { return { url: pathToFileURL(require.resolve(specifier)).href, shortCircuit: true } }
      finally { nested = false }
    }
    return next(specifier, context)
  } })
}
