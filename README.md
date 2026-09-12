# dsh-keep-going

English | [中文](README.zh-CN.md)

**Restart DSH without interrupting the work that is running.**

Normally a restart costs you the answer being written: DSH stops in the middle of it, and afterwards nothing tells the assistant to continue. This plugin removes both problems.

1. **It waits.** When a restart or a shutdown is requested, DSH does not stop immediately. The plugin waits until the running turns have finished, then asks DSH to close itself in an orderly way.
2. **It continues.** Before closing, it writes down which conversation asked for the restart. When DSH starts again, the plugin waits for that conversation to come back and sends it a message to carry on — you do not have to say anything.

```
you or the assistant ask for a restart
        │
        ▼
wait until the running turns have finished
        │
        ▼
write down the conversation to wake, then close DSH in an orderly way
        │
        ▼
the service manager (systemd, a Windows service, …) starts DSH again
        │
        ▼
DSH starts → the conversation is woken → the work continues
```

## What it does not do

| Not handled here | Handled by |
| --- | --- |
| Starting DSH again after it closes | your service manager — for example systemd with `Restart=always` |
| Undoing a plugin installation that stops DSH from starting | you; DSH reports the error and exits, it does not repair itself |
| A settings page, a browser button, a process dashboard | nothing — this plugin has no part in the browser interface |
| Waking any conversation other than the one that asked | on purpose: a restart wakes exactly one conversation, the one that requested it |

Keeping the scope this small is the point. The name says one thing: after the restart, keep going.

## Install

```sh
# from npm (once published)
dsh plugin --profile web add dsh-keep-going

# from a local copy
dsh plugin --profile web add /path/to/dsh-keep-going
```

Then restart DSH once so the plugin is loaded.

**One requirement:** something must start DSH again after it closes. If nothing does, a restart leaves DSH stopped. See [Deployment](#deployment).

## Tools and commands

| What you use | What it does | Does the conversation continue by itself? |
| --- | --- | --- |
| `restart_harness` (used by the assistant) | restarts after the current answer is finished | yes |
| `shutdown_harness` (used by the assistant) | closes DSH without restarting | not applicable |
| `cancel_harness_action` (used by the assistant) | cancels a restart or shutdown that has not happened yet | not applicable |
| `/restart` (typed by you) | restarts after the current answer is finished | no, it waits for you |
| `/shutdown` (typed by you) | closes DSH without restarting | not applicable |

Arguments of `restart_harness`:

| Argument | Meaning |
| --- | --- |
| `continuePrompt` | What the conversation is told when it wakes up. Replaces the default text from the settings. |
| `waitMs` | How long this particular restart waits for running turns, in milliseconds. Replaces `drainTimeoutMs`. |
| `force` | Restart even while **other** conversations are in the middle of an answer (default: no). Without it, the request is refused and the answer lists the conversations that are busy, so one conversation can never silently cut off another one's work. |

## Which conversation is woken

Only the one that asked for the restart — for `restart_harness` that is the conversation containing the tool call. The message it wakes up with is that conversation's own instruction, so sending it anywhere else would make another conversation start working on someone else's problem. Other conversations that were in the middle of an answer are not woken and not told anything; they are simply left where they are.

## Settings

These live in the `dsh-keep-going` section of `settings.yaml` and can also be edited in the settings page:

```yaml
dsh-keep-going:
  continuePrompt: DSH 已重启完成，请继续未完成的工作。
  drainTimeoutMs: 600000   # 10 minutes: stop waiting and close anyway
  stuckAgentMs: 60000      # 60 seconds without activity: stop counting a turn as running
  stormLimit: 5            # more than 5 restarts inside the window below: restart, but do not wake
  stormWindowMs: 300000
```

Two behaviours that matter:

- **A turn that has gone quiet stops blocking; a turn we know nothing about does not.** A conversation that is marked as running but has shown no activity for `stuckAgentMs` no longer holds up the restart. A conversation with no activity recorded at all still counts as running — so a restart can never throw away an answer just because the plugin had not seen that conversation yet.
- **The waiting limit forces the restart, it does not cancel it.** When `drainTimeoutMs` passes, DSH closes anyway, and the note telling the conversation to continue has already been written. A restart you asked for is never quietly dropped.

## Files it writes

Everything is inside `$DSH_HOME/dsh-keep-going/`:

- `restart.json` — written just before DSH closes, read and deleted at the next start.
- `state.json` — the times of recent restarts, used to stop a restart loop.

Delete that folder if you want to cancel a pending wake-up.

## Deployment

**Linux with systemd.** A service that restarts DSH on exit is enough:

```ini
[Service]
ExecStart=/path/to/dsh web --host 127.0.0.1 --port 3080
Restart=always
RestartSec=3
```

Because the plugin asks DSH to close itself rather than killing it, saved data is written out and the port is released before the process ends. The service manager then starts a fresh DSH, which finds the note and wakes the conversation.

**Windows, or no service manager.** Use something that starts DSH again when it exits — a Windows service, a scheduled task, or a small launcher in the notification area. The plugin itself never starts a process.

## Compatibility

Written and tested against DSH `0.1.5-rc.2`. The plugin declares which parts of DSH it uses, so installing it on a very different DSH version reports a mismatch instead of failing silently while starting.

## For developers

```sh
node --test "test/*.test.js"   # 22 tests
```

- `lib/policy.js` — every decision (when to stop waiting, which turns count as stuck, when to stop waking) as small functions with no side effects.
- `lib/state.js` — reading and writing the two files above.
- `lib/index.js` — connects the two to DSH.
- `test/smoke.test.js` — starts the plugin against a stand-in for DSH, including one test that runs a full restart and wake-up cycle.

## License

MIT
