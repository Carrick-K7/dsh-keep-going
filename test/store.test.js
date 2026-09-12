import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createStore } from '../lib/store.js'

const initial = () => ({ version: 2, jobs: {}, recentRestarts: [], stopRequested: false })

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-recovery-store-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const directory = path.join(root, 'private', 'recovery')
  const file = path.join(directory, 'recovery.json')
  return { root, directory, file, store: createStore(directory, { now: () => 1234 }) }
}

function seed(store) {
  return store.update((draft) => {
    draft.jobs.stable = { sessionId: 's1', messageId: 'm1', kind: 'marker', attempts: 1, details: { values: [1, null] } }
    draft.recentRestarts.push(100)
  })
}

function ioError(message = 'injected I/O failure') {
  return Object.assign(new Error(message), { code: 'EIO' })
}

test('missing state gives independent defaults without creating files', (t) => {
  const { directory, store } = fixture(t)
  assert.deepEqual(store.read(), initial())
  const read = store.read()
  read.jobs.leak = {}
  read.recentRestarts.push(1)
  assert.deepEqual(store.read(), initial())
  assert.equal(fs.existsSync(directory), false)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  assert.deepEqual(store.read(), initial())
  assert.deepEqual(fs.readdirSync(directory), [])
})

test('fresh instances roundtrip stable recovery ids, marker jobs, and unknown JSON fields', (t) => {
  const { directory, file, store } = fixture(t)
  const ids = ['recovery-a', 'same-session-second-message', '__proto__', 'constructor', 'toString', '恢复/id:!?']
  const committed = store.update((draft) => {
    for (const [index, id] of ids.entries()) {
      Object.defineProperty(draft.jobs, id, {
        enumerable: true, writable: true, configurable: true,
        value: {
          sessionId: 'same-session', messageId: `message-${index}`, kind: 'marker',
          expected: { identity: { messageId: `message-${index}`, nonce: id } },
          attempts: index, retryAt: 1_000_000 + index,
          futureField: { list: [null, true, false, 1.25, 'text'], nested: {} },
        },
      })
    }
    draft.jobs.empty = {}
    draft.recentRestarts = [1, 2, 3]
    draft.stopRequested = true
    draft.futureRootField = { retained: 'exactly' }
  })
  const bytes = fs.readFileSync(file, 'utf8')
  for (let restart = 0; restart < 5; restart++) {
    const next = createStore(directory)
    assert.deepEqual(next.read(), committed)
    assert.deepEqual(next.read(), committed, 'reading does not consume marker jobs')
    assert.equal(fs.readFileSync(file, 'utf8'), bytes)
  }
  assert.deepEqual(Object.keys(committed.jobs), [...ids, 'empty'])
  assert.deepEqual(JSON.parse(bytes), committed)
})

test('every update reloads the latest state rather than overwriting another instance', (t) => {
  const { directory, store } = fixture(t)
  const other = createStore(directory)
  store.update((draft) => { draft.jobs.first = { attempts: 1 } })
  other.update((draft) => { draft.jobs.second = { attempts: 2 } })
  store.update((draft) => { draft.jobs.first.attempts++ })
  assert.deepEqual(other.read().jobs, { first: { attempts: 2 }, second: { attempts: 2 } })
})

test('read, committed return value, and retained drafts are deeply detached', (t) => {
  const { store } = fixture(t)
  let retained
  const committed = store.update((draft) => {
    draft.jobs.one = { nested: { array: [{ value: 1 }] } }
    draft.recentRestarts.push(5)
    retained = draft
  })
  retained.jobs.one.nested.array[0].value = 2
  assert.equal(committed.jobs.one.nested.array[0].value, 1)
  committed.jobs.one.nested.array.push('leak')
  committed.recentRestarts.push(6)
  const read = store.read()
  read.jobs.one.nested.array[0].value = 3
  read.jobs.extra = {}
  assert.deepEqual(store.read(), {
    version: 2, jobs: { one: { nested: { array: [{ value: 1 }] } } }, recentRestarts: [5], stopRequested: false,
  })
})

test('a throwing mutator leaves the previous bytes intact and releases the update guard', (t) => {
  const { file, store } = fixture(t)
  const previous = seed(store)
  const bytes = fs.readFileSync(file, 'utf8')
  const failure = new Error('mutation failed')
  assert.throws(() => store.update((draft) => {
    delete draft.jobs.stable
    draft.recentRestarts.push(2)
    throw failure
  }), (error) => error === failure)
  assert.equal(fs.readFileSync(file, 'utf8'), bytes)
  assert.deepEqual(store.read(), previous)
  assert.equal(store.update((draft) => { draft.jobs.stable.attempts++ }).jobs.stable.attempts, 2)
})

test('failed initial mutation does not create a recovery directory', (t) => {
  const { directory, store } = fixture(t)
  assert.throws(() => store.update(() => { throw new Error('stop') }), /stop/)
  assert.equal(fs.existsSync(directory), false)
})

test('reentrant updates through the same or another instance cannot lose writes', (t) => {
  const { file, directory, store } = fixture(t)
  const previous = seed(store)
  const bytes = fs.readFileSync(file, 'utf8')
  for (const nested of [store, createStore(path.join(directory, '.'))]) {
    assert.throws(() => store.update((draft) => {
      draft.jobs.outer = {}
      nested.update((inner) => { inner.jobs.inner = {} })
    }), /Reentrant/)
    assert.deepEqual(store.read(), previous)
    assert.equal(fs.readFileSync(file, 'utf8'), bytes)
  }
  store.update((draft) => {
    assert.deepEqual(store.read(), previous, 'reads during mutation see only committed state')
    assert.throws(() => store.update(() => {}), /Reentrant/)
    draft.jobs.outer = {}
  })
  assert.deepEqual(store.read().jobs.outer, {})
})

test('async mutators and thenables are rejected without committing', async (t) => {
  const { file, store } = fixture(t)
  seed(store)
  const bytes = fs.readFileSync(file, 'utf8')
  assert.throws(() => store.update(async (draft) => {
    draft.jobs.async = {}
    await Promise.resolve()
    draft.stopRequested = true
    throw new Error('async mutation must not become an unhandled rejection')
  }), /synchronous/)
  assert.throws(() => store.update(() => ({ then(resolve) { resolve() } })), /synchronous/)
  await Promise.resolve()
  assert.equal(fs.readFileSync(file, 'utf8'), bytes)
  assert.deepEqual(store.update(() => {}).jobs, store.read().jobs)
})

const invalidDocuments = [
  ['truncated JSON', '{"version":2,"jobs":'],
  ['empty JSON', ''],
  ['null root', 'null'],
  ['array root', '[]'],
  ['missing version', JSON.stringify({ jobs: {}, recentRestarts: [], stopRequested: false })],
  ['old version', JSON.stringify({ ...initial(), version: 1 })],
  ['future version', JSON.stringify({ ...initial(), version: 3 })],
  ['string version', JSON.stringify({ ...initial(), version: '2' })],
  ['non-finite parsed number', '{"version":2,"jobs":{"x":{"n":1e999}},"recentRestarts":[],"stopRequested":false}'],
  ['array jobs', JSON.stringify({ ...initial(), jobs: [] })],
  ['null jobs', JSON.stringify({ ...initial(), jobs: null })],
  ['null job', JSON.stringify({ ...initial(), jobs: { x: null } })],
  ['array job', JSON.stringify({ ...initial(), jobs: { x: [] } })],
  ['primitive job', JSON.stringify({ ...initial(), jobs: { x: 'bad' } })],
  ['non-array restart history', JSON.stringify({ ...initial(), recentRestarts: {} })],
  ['non-boolean stop flag', JSON.stringify({ ...initial(), stopRequested: 1 })],
]
for (const [name, contents] of invalidDocuments) {
  test(`${name} throws on read/update and is never erased`, (t) => {
    const { directory, file, store } = fixture(t)
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    fs.writeFileSync(file, contents, { mode: 0o600 })
    for (const instance of [store, createStore(directory)]) {
      assert.throws(() => instance.read())
      let called = false
      assert.throws(() => instance.update(() => { called = true }))
      assert.equal(called, false)
      assert.equal(fs.readFileSync(file, 'utf8'), contents)
      assert.deepEqual(fs.readdirSync(directory), ['recovery.json'])
    }
  })
}

test('malformed UTF-8 is not silently repaired or overwritten', (t) => {
  const { directory, file, store } = fixture(t)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const bytes = Buffer.concat([
    Buffer.from('{"version":2,"jobs":{"x":{"text":"'), Buffer.from([0xff]),
    Buffer.from('"}},"recentRestarts":[],"stopRequested":false}'),
  ])
  fs.writeFileSync(file, bytes, { mode: 0o600 })
  assert.throws(() => store.read(), TypeError)
  assert.throws(() => store.update(() => {}), TypeError)
  assert.deepEqual(fs.readFileSync(file), bytes)
  assert.deepEqual(fs.readdirSync(directory), ['recovery.json'])
})

const invalidMutations = [
  ['undefined', (draft) => { draft.jobs.stable.bad = undefined }],
  ['NaN', (draft) => { draft.jobs.stable.bad = NaN }],
  ['infinity', (draft) => { draft.jobs.stable.bad = Infinity }],
  ['bigint', (draft) => { draft.jobs.stable.bad = 1n }],
  ['function', (draft) => { draft.jobs.stable.bad = () => 1 }],
  ['symbol value', (draft) => { draft.jobs.stable.bad = Symbol('bad') }],
  ['symbol key', (draft) => { draft.jobs.stable[Symbol('bad')] = 1 }],
  ['hidden property', (draft) => { Object.defineProperty(draft.jobs.stable, 'hidden', { value: 1 }) }],
  ['accessor', (draft) => { Object.defineProperty(draft.jobs.stable, 'getter', { enumerable: true, get: () => 1 }) }],
  ['cycle', (draft) => { draft.jobs.stable.bad = draft }],
  ['sparse array', (draft) => { draft.jobs.stable.bad = [1, , 3] }],
  ['extra array property', (draft) => { draft.jobs.stable.bad = Object.assign([1], { extra: 2 }) }],
  ['sparse array with compensating property', (draft) => { draft.jobs.stable.bad = Object.assign(new Array(1), { extra: 2 }) }],
  ['Date coercion', (draft) => { draft.jobs.stable.bad = new Date(0) }],
  ['Map coercion', (draft) => { draft.jobs.stable.bad = new Map([['a', 1]]) }],
  ['toJSON coercion', (draft) => { draft.jobs.stable.toJSON = () => ({ lost: true }) }],
  ['custom array toJSON', (draft) => {
    class CustomArray extends Array { toJSON() { return 'lost' } }
    draft.jobs.stable.bad = new CustomArray(1, 2)
  }],
  ['changed version', (draft) => { draft.version = 1 }],
  ['missing jobs', (draft) => { delete draft.jobs }],
  ['array jobs', (draft) => { draft.jobs = [] }],
  ['null job', (draft) => { draft.jobs.invalid = null }],
  ['array job', (draft) => { draft.jobs.invalid = [] }],
  ['missing restart history', (draft) => { delete draft.recentRestarts }],
  ['invalid stop flag', (draft) => { draft.stopRequested = 'yes' }],
]
for (const [name, mutate] of invalidMutations) {
  test(`invalid mutation (${name}) does not replace good state`, (t) => {
    const { directory, file, store } = fixture(t)
    seed(store)
    const bytes = fs.readFileSync(file, 'utf8')
    assert.throws(() => store.update(mutate), TypeError)
    assert.equal(fs.readFileSync(file, 'utf8'), bytes)
    assert.deepEqual(fs.readdirSync(directory), ['recovery.json'])
    assert.doesNotThrow(() => store.update(() => {}), 'validation failure releases the guard')
  })
}

test('null-prototype JSON records and repeated non-cyclic references are preserved', (t) => {
  const { store } = fixture(t)
  const shared = Object.assign(Object.create(null), { future: [1, null, 'ok'] })
  const committed = store.update((draft) => {
    draft.jobs = Object.create(null)
    draft.jobs.__proto__ = { left: shared, right: shared }
  })
  assert.deepEqual(committed.jobs.__proto__, { left: { future: [1, null, 'ok'] }, right: { future: [1, null, 'ok'] } })
  assert.notEqual(committed.jobs.__proto__.left, committed.jobs.__proto__.right)
})

const writeFailures = [
  ['exclusive temp open', 'openSync', ([target]) => typeof target === 'string' && target.endsWith('.tmp')],
  ['temp chmod', 'fchmodSync', () => true],
  ['partial write', 'writeFileSync', ([target]) => typeof target === 'number'],
  ['file fsync', 'fsyncSync', ([fd]) => fs.fstatSync(fd).isFile()],
  ['rename', 'renameSync', () => true],
]
for (const [name, method, shouldFail] of writeFailures) {
  test(`${name} failure preserves last good state and removes only this update's temp`, (t) => {
    const { directory, file, store } = fixture(t)
    const previous = seed(store)
    const bytes = fs.readFileSync(file, 'utf8')
    const unrelated = path.join(directory, '.recovery.json.some-other-writer.tmp')
    fs.writeFileSync(unrelated, 'do not delete', { mode: 0o600 })
    const failure = ioError(name)
    const original = fs[method]
    t.mock.method(fs, method, (...args) => {
      if (shouldFail(args)) {
        if (method === 'writeFileSync') original(args[0], args[1].slice(0, 8), args[2])
        throw failure
      }
      return original(...args)
    })
    assert.throws(() => store.update((draft) => { draft.jobs.stable.attempts = 99 }), (error) => error === failure)
    assert.equal(fs.readFileSync(file, 'utf8'), bytes)
    assert.deepEqual(store.read(), previous)
    assert.equal(fs.readFileSync(unrelated, 'utf8'), 'do not delete')
    assert.deepEqual(fs.readdirSync(directory).sort(), [path.basename(unrelated), 'recovery.json'].sort())
  })
}

test('an exclusive-open collision never overwrites or deletes the pre-existing temp', (t) => {
  const { directory, file, store } = fixture(t)
  seed(store)
  const bytes = fs.readFileSync(file, 'utf8')
  const original = fs.openSync
  let collision
  t.mock.method(fs, 'openSync', (target, flags, mode) => {
    if (typeof target === 'string' && target.endsWith('.tmp')) {
      collision = target
      const fd = original(target, 'wx', 0o600)
      try { fs.writeFileSync(fd, 'not owned by this update') } finally { fs.closeSync(fd) }
    }
    return original(target, flags, mode)
  })
  assert.throws(() => store.update((draft) => { draft.stopRequested = true }), { code: 'EEXIST' })
  assert.equal(fs.readFileSync(file, 'utf8'), bytes)
  assert.equal(fs.readFileSync(collision, 'utf8'), 'not owned by this update')
  assert.deepEqual(fs.readdirSync(directory).sort(), [path.basename(collision), 'recovery.json'].sort())
})

test('temp filenames are unique even with a fixed clock and are exclusively opened mode 0600', (t) => {
  const { directory, store } = fixture(t)
  const original = fs.openSync
  const temps = []
  t.mock.method(fs, 'openSync', (target, flags, mode) => {
    if (typeof target === 'string' && target.endsWith('.tmp')) temps.push({ target, flags, mode })
    return original(target, flags, mode)
  })
  for (let i = 0; i < 3; i++) store.update((draft) => { draft.recentRestarts.push(i) })
  assert.equal(new Set(temps.map(({ target }) => target)).size, 3)
  for (const { target, flags, mode } of temps) {
    assert.equal(path.dirname(target), directory)
    assert.equal(flags, 'wx')
    assert.equal(mode, 0o600)
  }
  assert.deepEqual(fs.readdirSync(directory), ['recovery.json'])
})

test('Linux/POSIX commit order is write, file fsync, rename, directory fsync', { skip: process.platform === 'win32' }, (t) => {
  const { store } = fixture(t)
  seed(store)
  const events = []
  for (const method of ['writeFileSync', 'fsyncSync', 'renameSync']) {
    const original = fs[method]
    t.mock.method(fs, method, (...args) => {
      events.push(method === 'fsyncSync' ? (fs.fstatSync(args[0]).isDirectory() ? 'directory fsync' : 'file fsync') : method)
      return original(...args)
    })
  }
  store.update((draft) => { draft.stopRequested = true })
  assert.deepEqual(events, ['writeFileSync', 'file fsync', 'renameSync', 'directory fsync'])
})

test('new nested directory entries are synced in their parents', { skip: process.platform === 'win32' }, (t) => {
  const { root, directory, store } = fixture(t)
  const handles = new Map()
  const synced = []
  const open = fs.openSync
  const sync = fs.fsyncSync
  const close = fs.closeSync
  t.mock.method(fs, 'openSync', (...args) => {
    const fd = open(...args)
    handles.set(fd, args[0])
    return fd
  })
  t.mock.method(fs, 'closeSync', (fd) => { handles.delete(fd); return close(fd) })
  t.mock.method(fs, 'fsyncSync', (fd) => {
    if (fs.fstatSync(fd).isDirectory()) synced.push(handles.get(fd))
    return sync(fd)
  })
  store.update(() => {})
  assert.deepEqual(synced, [root, path.dirname(directory), directory])
})

test('directory fsync failure propagates even though rename has already committed', { skip: process.platform === 'win32' }, (t) => {
  const { directory, store } = fixture(t)
  seed(store)
  const failure = ioError('directory fsync failed after rename')
  const original = fs.fsyncSync
  t.mock.method(fs, 'fsyncSync', (fd) => {
    if (fs.fstatSync(fd).isDirectory()) throw failure
    return original(fd)
  })
  assert.throws(() => store.update((draft) => { draft.stopRequested = true }), (error) => error === failure)
  assert.equal(createStore(directory).read().stopRequested, true)
  assert.deepEqual(fs.readdirSync(directory), ['recovery.json'])
})

test('Linux unsupported-directory-fsync errors are not silently ignored', { skip: process.platform === 'win32' }, (t) => {
  const { store } = fixture(t)
  seed(store)
  const original = fs.fsyncSync
  t.mock.method(fs, 'fsyncSync', (fd) => {
    if (fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error('unsupported'), { code: 'EINVAL' })
    return original(fd)
  })
  assert.throws(() => store.update(() => {}), { code: 'EINVAL' })
})

test('read and directory-creation I/O failures propagate rather than defaulting', (t) => {
  const { directory, store } = fixture(t)
  const failure = ioError('mkdir failure')
  const mkdirMock = t.mock.method(fs, 'mkdirSync', () => { throw failure })
  assert.throws(() => store.update(() => {}), (error) => error === failure)
  assert.equal(fs.existsSync(directory), false)
  mkdirMock.mock.restore()
  seed(store)
  const readFailure = Object.assign(new Error('permission denied'), { code: 'EACCES' })
  t.mock.method(fs, 'readFileSync', () => { throw readFailure })
  assert.throws(() => store.read(), (error) => error === readFailure)
  assert.throws(() => store.update(() => {}), (error) => error === readFailure)
})

test('cleanup failure is reported with the original failure and leaves unrelated files intact', (t) => {
  const { directory, file, store } = fixture(t)
  seed(store)
  const bytes = fs.readFileSync(file, 'utf8')
  const writeFailure = ioError('rename failed')
  const cleanupFailure = ioError('unlink failed')
  t.mock.method(fs, 'renameSync', () => { throw writeFailure })
  t.mock.method(fs, 'unlinkSync', () => { throw cleanupFailure })
  assert.throws(() => store.update(() => {}), (error) => {
    assert.ok(error instanceof AggregateError)
    assert.deepEqual(error.errors, [writeFailure, cleanupFailure])
    return true
  })
  assert.equal(fs.readFileSync(file, 'utf8'), bytes)
  assert.equal(fs.readdirSync(directory).length, 2, 'own temp remains when cleanup itself fails')
})

test('new directories are private and every replacement file is mode 0600', { skip: process.platform === 'win32' }, (t) => {
  const { directory, file, store } = fixture(t)
  seed(store)
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700)
  assert.equal(fs.statSync(path.dirname(directory)).mode & 0o777, 0o700)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  fs.chmodSync(directory, 0o750)
  fs.chmodSync(file, 0o644)
  store.read()
  assert.equal(fs.statSync(file).mode & 0o777, 0o644, 'reading does not modify the file')
  store.update(() => {})
  assert.equal(fs.statSync(directory).mode & 0o777, 0o750, 'existing directory permissions are left alone')
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
})

test('symlink recovery directories are rejected without touching their targets', { skip: process.platform === 'win32' }, (t) => {
  const { root, directory, store } = fixture(t)
  const target = path.join(root, 'target')
  fs.mkdirSync(target, { mode: 0o700 })
  fs.mkdirSync(path.dirname(directory), { mode: 0o700 })
  fs.symlinkSync(target, directory, 'dir')
  assert.throws(() => store.read(), /non-symlink/)
  assert.throws(() => store.update(() => {}), /non-symlink/)
  assert.equal(fs.lstatSync(directory).isSymbolicLink(), true)
  assert.deepEqual(fs.readdirSync(target), [])
})

for (const dangling of [false, true]) {
  test(`${dangling ? 'dangling' : 'existing'} symlink state files are rejected and preserved`, { skip: process.platform === 'win32' }, (t) => {
    const { root, directory, file, store } = fixture(t)
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    const target = path.join(root, 'target.json')
    const contents = JSON.stringify(initial())
    if (!dangling) fs.writeFileSync(target, contents, { mode: 0o600 })
    fs.symlinkSync(target, file)
    assert.throws(() => store.read(), /non-symlink/)
    assert.throws(() => store.update(() => {}), /non-symlink/)
    assert.equal(fs.lstatSync(file).isSymbolicLink(), true)
    if (!dangling) assert.equal(fs.readFileSync(target, 'utf8'), contents)
    else assert.equal(fs.existsSync(target), false)
  })
}

test('non-regular state paths and non-directory store paths fail closed', (t) => {
  const { root, directory, file, store } = fixture(t)
  fs.mkdirSync(file, { recursive: true, mode: 0o700 })
  assert.throws(() => store.read(), /regular file/)
  assert.throws(() => store.update(() => {}), /regular file/)
  const notDirectory = path.join(root, 'not-a-directory')
  fs.writeFileSync(notDirectory, 'keep me', { mode: 0o600 })
  assert.throws(() => createStore(notDirectory).read(), /directory/)
  assert.throws(() => createStore(notDirectory).update(() => {}), /directory/)
  assert.deepEqual(fs.readdirSync(directory), ['recovery.json'])
  assert.equal(fs.readFileSync(notDirectory, 'utf8'), 'keep me')
})
