/**
 * Durable state for dsh-keep-going: the restart marker and the exit history.
 *
 * Layout under `$DSH_HOME/dsh-keep-going/`:
 *   - `restart.json` — written before the process exits, consumed by the next boot
 *   - `state.json`   — rolling exit timestamps for the restart-storm guard
 *
 * Writes are atomic (temp file + rename) because the marker is written moments
 * before the process exits and must never be observed half-written.
 * @module dsh-keep-going/state
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildMarker, normalizeMarker, stormDecision } from './policy.js'

/** Resolve the DSH home directory the same way the harness does. */
export function resolveHome(env = process.env, homedir = os.homedir) {
  const configured = env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return configured
  return path.join(homedir(), '.dsh')
}

/** @returns Absolute path of the plugin's state directory. */
export function stateDir(env) {
  return path.join(resolveHome(env), 'dsh-keep-going')
}

/** @returns Absolute path of the restart marker. */
export function markerPath(env) {
  return path.join(stateDir(env), 'restart.json')
}

/** @returns Absolute path of the exit-history state file. */
export function historyPath(env) {
  return path.join(stateDir(env), 'state.json')
}

/**
 * Atomically write a JSON document, creating the directory on first use.
 * @param file - Target path.
 * @param value - JSON-serializable value.
 */
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

/**
 * Read a JSON document, treating any failure as "absent".
 * @param file - Source path.
 * @returns The parsed value, or `null`.
 */
export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Persist the marker the next boot will consume.
 * @param options - Action, wake intent, target sessions, prompt and exit history.
 * @returns The marker that was written.
 */
export function writeMarker(options) {
  const marker = buildMarker(options)
  writeJson(markerPath(options.env), marker)
  return marker
}

/**
 * Read the previous boot's marker and delete it (consume-once).
 *
 * Consuming here — not after delivery — keeps a crash during delivery from
 * re-waking the same session on every subsequent boot.
 * @param env - Environment carrying `DSH_HOME`.
 * @returns The normalized marker, or `null` when there is none.
 */
export function consumeMarker(env) {
  const file = markerPath(env)
  const marker = normalizeMarker(readJson(file))
  try {
    fs.rmSync(file, { force: true })
  } catch {
    // The marker is consumed best-effort; a leftover file only re-wakes once.
  }
  return marker
}

/**
 * Append this exit to the rolling history and report whether waking is allowed.
 * @param env - Environment carrying `DSH_HOME`.
 * @param limit - Maximum exits allowed inside the window.
 * @param windowMs - Rolling window length in ms.
 * @param now - Current epoch-ms.
 * @returns The pruned exit history and the wake verdict.
 */
export function recordExit(env, limit, windowMs, now) {
  const previous = readJson(historyPath(env))
  const exits = previous && Array.isArray(previous.exits) ? previous.exits : []
  const decision = stormDecision(exits, now, limit, windowMs)
  writeJson(historyPath(env), { exits: decision.history, at: new Date(now).toISOString() })
  return decision
}
