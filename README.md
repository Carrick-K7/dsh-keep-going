# dsh-keep-going

Restart DSH **without losing the task in flight**.

A restart normally costs you the turn that was running: the process dies mid-answer, and afterwards nobody tells the agent to continue. `dsh-keep-going` closes both halves of that gap:

1. **It waits.** A restart/shutdown armed by a tool or command does not kill the process immediately — the plugin waits for in-flight turns to finish (with a deadline, and with stuck turns excluded), then requests a *clean* exit through the harness's own shutdown path.
2. **It resumes.** Before exiting it records which session asked, in `$DSH_HOME/dsh-keep-going/restart.json`. The next process reads that marker, waits for the session to come back, and steers it with a continue prompt — so the conversation picks up where it left off, with no message from you.

```
restart_harness  ──▶  wait for turns  ──▶  marker + clean exit
                                                │
                            supervisor (systemd Restart=always) replaces the process
                                                │
                          next boot ──▶ read marker ──▶ steer the session ──▶ keeps going
```

## What it deliberately does *not* do

| Not in scope | Who owns it |
| --- | --- |
| Respawning the process | your supervisor — systemd `Restart=always`, a Windows service, … |
| Disabling/rolling back a plugin set that breaks startup | you (the harness fails loud and exits) |
| A browser half, a settings page, a process dashboard | nothing — this plugin is host-only |
| Waking sessions that were idle when you asked for the restart | intentional: only the caller (and other sessions that were mid-turn) are woken |

Keeping the scope this narrow is the point. The name says one thing: after the restart, keep going.

## Install

```sh
# from npm (once published)
dsh plugin --profile web add dsh-keep-going

# from a checkout
dsh plugin --profile web add /path/to/dsh-keep-going
```

Then restart the service once so the plugin is mounted (`systemctl restart deepseek-harness`).

**Requirement:** the DSH process must be supervised. Without a supervisor nothing replaces the exited process — see [Deployment](#deployment).

## Tools and commands

| Surface | Effect | Wakes the caller |
| --- | --- | --- |
| `restart_harness` (model tool) | restart after the current turn | ✅ |
| `shutdown_harness` (model tool) | exit without restarting | — |
| `cancel_harness_action` (model tool) | revoke an armed action before it runs | — |
| `/restart` (command) | restart after the current turn | ❌ (waits for you) |
| `/shutdown` (command) | exit without restarting | — |

`restart_harness` arguments:

| Argument | Meaning |
| --- | --- |
| `continuePrompt` | Text steered into the session after the restart. Overrides the configured default. |
| `waitMs` | Drain deadline for this call (overrides `drainTimeoutMs`). |
| `force` | Restart even while **other** sessions are mid-turn (default `false`). Without it the call is refused and returns the in-flight session list, so one session can never silently cut another one's work. |

## Settings

Resolved from the `dsh-keep-going` section of `settings.yaml`, editable live from the GUI:

```yaml
dsh-keep-going:
  continuePrompt: DSH 已重启完成，请继续未完成的工作。
  drainTimeoutMs: 600000   # 10 min: exit anyway once this passes
  stuckAgentMs: 60000      # 60 s: a running agent with no activity stops blocking
  stormLimit: 5            # >5 exits inside stormWindowMs ⇒ restart, but do not wake
  stormWindowMs: 300000
```

Two semantics worth knowing:

- **Stuck turns are skipped, unknown ones are not.** A `running` agent whose last session activity is older than `stuckAgentMs` no longer blocks the restart. An agent with *no* recorded activity counts as live — so a restart can never discard a turn just because activity tracking has not caught up.
- **The deadline forces, it does not cancel.** When `drainTimeoutMs` passes, the exit happens anyway and the wake marker is already written, so the interrupted session is resumed. A restart request is never silently dropped.

## Files it owns

Everything lives under `$DSH_HOME/dsh-keep-going/`:

- `restart.json` — written before the exit, consumed (deleted) by the next boot.
- `state.json` — rolling exit timestamps for the storm guard.

Delete the directory to forget a pending wake.

## Deployment

**systemd (Linux).** A unit with `Restart=always` is enough:

```ini
[Service]
ExecStart=/path/to/dsh web --host 127.0.0.1 --port 3080
Restart=always
RestartSec=3
```

Because the exit is requested through `ctx.appExit`, storage flushes and the port is released before the process ends — the supervisor then starts a fresh process that finds the marker.

**Windows / no supervisor.** Add a small supervisor (service, task, or tray launcher) that restarts `dsh` when it exits; the plugin does not respawn anything itself.

## Compatibility

Built against DSH `0.1.5-rc.2` (`ctx.appExit`, `ctx.agents`, `ctx.tools`, `ctx.commands`, `settings.installSection`). The optional `@deepseek-ai/*` peers are declared so an install surfaces version drift instead of failing silently at boot.

## Development

```sh
node --test "test/*.test.js"   # 16 tests: pure policy + a fake-context smoke boot
```

`lib/policy.js` holds every decision (drain, stuck detection, storm guard, marker shape) as pure functions — the parts worth testing without booting a profile. `lib/state.js` owns the two JSON files. `lib/index.js` wires both into Cordis.

## License

MIT
