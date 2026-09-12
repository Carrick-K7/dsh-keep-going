/**
 * Synchronous, single-process recovery storage. Reads never consume jobs.
 * Each update reloads recovery.json and commits JSON data without normalization.
 *
 * Linux commits fsync the file, rename it, then fsync its directory. New directory
 * entries are also synced in their parents. On Windows only unsupported directory
 * open/fsync errors (EISDIR, EPERM, EINVAL, ENOTSUP) are best-effort; file I/O and
 * all other failures still throw. A failure after rename can leave the new state
 * visible: callers must treat ANY failure as unsafe to restart.
 *
 * No cross-process locking or hostile-directory race protection is provided.
 * The configured directory and state file cannot be symlinks; existing ancestor
 * directories must be trusted. Existing directory permissions are not changed.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const updating = new Set()
const noFollow = fs.constants.O_NOFOLLOW ?? 0
const directoryFlag = fs.constants.O_DIRECTORY ?? 0
const defaultState = () => ({ version: 2, jobs: {}, recentRestarts: [], stopRequested: false })
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

// Reject values JSON.stringify would silently drop, coerce, or replace via
// toJSON. Only ordinary JSON records (including null-prototype objects) and
// dense arrays are accepted; accessors, hidden fields, and symbol keys are not.
function validateJson(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (typeof value !== 'object') throw new TypeError('Recovery state must contain only valid JSON values')
  const array = Array.isArray(value)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== (array ? Array.prototype : Object.prototype) && prototype !== null) {
    throw new TypeError('Recovery state must contain only JSON records and arrays')
  }
  if (ancestors.has(value)) throw new TypeError('Recovery state cannot contain circular JSON')
  const keys = Reflect.ownKeys(value)
  if (array && keys.length !== value.length + 1) {
    throw new TypeError('Recovery state arrays must be dense and have no extra fields')
  }
  ancestors.add(value)
  for (const key of keys) {
    if (array && key === 'length') continue
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError('Recovery state fields must be enumerable JSON data properties')
    }
    if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) {
      throw new TypeError('Recovery state arrays cannot have extra fields')
    }
    validateJson(descriptor.value, ancestors)
  }
  ancestors.delete(value)
}

function validateState(state) {
  validateJson(state)
  if (!isRecord(state) || state.version !== 2) {
    throw new TypeError('Unrecognized recovery state version (expected version 2)')
  }
  if (!isRecord(state.jobs) || Object.values(state.jobs).some((job) => !isRecord(job))) {
    throw new TypeError('Recovery state jobs and every job must be JSON objects')
  }
  if (!Array.isArray(state.recentRestarts) || typeof state.stopRequested !== 'boolean') {
    throw new TypeError('Recovery state requires recentRestarts array and stopRequested boolean')
  }
}

function inspect(target, directory = false) {
  let stat
  try {
    stat = fs.lstatSync(target)
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
  if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile())) {
    throw new Error(`Recovery ${directory ? 'directory' : 'file'} must be a non-symlink ${directory ? 'directory' : 'regular file'}: ${target}`)
  }
  return true
}

function syncDirectory(directory) {
  let fd
  try {
    fd = fs.openSync(directory, fs.constants.O_RDONLY | directoryFlag | noFollow)
    fs.fsyncSync(fd)
  } catch (error) {
    if (process.platform !== 'win32' || !['EISDIR', 'EPERM', 'EINVAL', 'ENOTSUP'].includes(error.code)) throw error
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

function ensureDirectory(directory) {
  if (inspect(directory, true)) return
  const parent = path.dirname(directory)
  ensureDirectory(parent)
  fs.mkdirSync(directory, { mode: 0o700 })
  syncDirectory(parent)
}

/**
 * @param {string} directory Dedicated, trusted recovery directory.
 * @param {{now?: () => number}} options Clock used only for unique temp names.
 * @returns {{read: () => object, update: (mutator: (draft: object) => void) => object}}
 */
export function createStore(directory, { now = Date.now } = {}) {
  const resolved = path.resolve(directory)
  const file = path.join(resolved, 'recovery.json')
  if (typeof now !== 'function') throw new TypeError('Recovery store now must be a function')

  function read() {
    if (!inspect(resolved, true) || !inspect(file)) return defaultState()
    const fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow)
    let text
    try {
      if (!fs.fstatSync(fd).isFile()) throw new Error('Recovery state must be a regular file')
      // Do not silently repair corrupt UTF-8 into replacement characters.
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(fd))
    } finally {
      fs.closeSync(fd)
    }
    const state = JSON.parse(text)
    validateState(state)
    return state // Freshly parsed JSON is detached; there is no in-memory cache.
  }

  function commit(text) {
    const timestamp = now()
    if (!Number.isFinite(timestamp)) throw new TypeError('Recovery store now must return a finite number')
    ensureDirectory(resolved)
    const temp = path.join(resolved, `.recovery.json.${process.pid}.${timestamp}.${randomUUID()}.tmp`)
    let ownsTemp = false
    try {
      const fd = fs.openSync(temp, 'wx', 0o600)
      ownsTemp = true
      try {
        fs.fchmodSync(fd, 0o600)
        fs.writeFileSync(fd, text, 'utf8')
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      // Recheck after the mutator; it may have performed unrelated filesystem I/O.
      if (!inspect(resolved, true)) throw new Error('Recovery directory disappeared during update')
      inspect(file)
      fs.renameSync(temp, file)
      ownsTemp = false
      syncDirectory(resolved)
    } catch (error) {
      if (ownsTemp) {
        try {
          fs.unlinkSync(temp)
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Recovery commit and temporary-file cleanup failed', { cause: error })
        }
      }
      throw error
    }
  }

  function update(mutator) {
    if (updating.has(resolved)) throw new Error('Reentrant recovery store update is not allowed')
    if (typeof mutator !== 'function') throw new TypeError('Recovery store mutator must be a function')
    updating.add(resolved)
    try {
      const draft = read() // Clone of the latest on-disk state, including other instances' updates.
      const result = mutator(draft)
      if (result && typeof result.then === 'function') {
        // Reject async mutation without an unhandled rejection from its Promise.
        Promise.resolve(result).catch(() => {})
        throw new TypeError('Recovery store mutator must be synchronous')
      }
      validateState(draft)
      const text = `${JSON.stringify(draft)}\n`
      commit(text)
      return JSON.parse(text) // Do not expose the mutator's retained draft.
    } finally {
      updating.delete(resolved)
    }
  }

  return { read, update }
}
