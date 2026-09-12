# dsh-keep-going

English | [中文](README.zh-CN.md)

**A gateway restart should not leave every unfinished conversation waiting for you to say “continue”.**

## The problem

Several conversations are working normally. One asks DSH to restart after installing a plugin. DSH comes back, but the other tasks do not. Their history is still there; their work has simply stopped. You have to find each conversation and tell it to continue.

`dsh-keep-going` restores unfinished work using DSH's saved conversation history. It does not require a browser to reopen each conversation, and it is not limited to restarts requested through the plugin.

A restart still briefly disconnects the process. The promise is **automatic task recovery**, not an uninterrupted network connection or restarting every task from the beginning.

## Expected behaviour

| Before the restart | After DSH starts again |
| --- | --- |
| An original goal is `active` | Restore its conversation and continue the goal. No recent-activity cutoff. |
| A goal is paused, blocked or complete | Leave it stopped. Do not send a separate “continue” that bypasses this state. |
| A conversation is **archived** | Never recovered. Archived means deliberately shelved; recovery skips it entirely. |
| An ordinary task was interrupted | Restore its history and continue the unfinished work. |
| A question is waiting for your answer | Keep the original question and remain waiting. Your reply in that conversation lets work continue. |
| A task completed or you canceled it | Do not restart it. |
| Recovery fails temporarily | Keep the recovery record and retry with increasing delays. |
| Another conversation requested the restart | Never send its private continuation instructions to this conversation. |

Copied history in a new fork does not by itself authorize a second copy of the parent's work. A fork's own new tasks can still be recovered.

## Install

Distributed through GitHub only; this package is not published to npm.

```sh
dsh plugin --profile web add git+https://github.com/Carrick-K7/dsh-keep-going.git#0.2.3
```

## When it acts — and when it stays out of the way

Recovery runs **once after each process restart**, then the plugin goes dormant:

- At boot it scans persisted sessions once, restores eligible original work, and stops.
- There is **no periodic scanning and no automatic restarting of conversations** while DSH is running normally. A user opening an old conversation is a normal action, not a restart: nothing is woken or re-armed by that alone.
- An `active` goal interrupted by a restart is re-armed exactly once and handed entirely to DSH's own goal driver. If the driver later disarms it (an error, a limit), that is DSH's normal lifecycle — the plugin does not keep re-arming it in the background; only the next process restart recovers it again.
- The only exception: while a requested restart is waiting for running work (drain), the plugin tracks live sessions so the exit is safe; and a goal that was interrupted while it was running is restored as a goal round, not as a generic “continue” — old work belonging to an active goal is handed to the goal driver, so it never receives someone else's prompt.

Restart DSH after installation. **A service manager must start DSH again when it exits.** This plugin does not launch replacement processes.

Tested with DSH `0.1.5-rc.2`. The profile must provide native sessions, persistent session query, the session controller, goals, tools and commands. Missing required services are a deployment error, not a silently disabled recovery feature.

## Restart and status

- **`restart_harness`**: wait for running work, save newly received messages, then request a normal DSH exit. Accepts `continuePrompt` for the calling conversation only, `waitMs`, and `force`.
- **`/restart`**: the same normal waiting behaviour, with the command's conversation retained as the caller.
- **`cancel_harness_action` / `/cancel-restart`**: cancel a pending restart from the conversation that requested it. The slash command works without starting a model turn. A second request cannot replace the first one's deadline or instructions.
- **`keep_going_status` / `/keep-going`**: inspect restart progress and recovery problems in the current conversation, including unanswered questions.
- **`keep_going_clear_goal`**: remove a goal that is stopped (paused, blocked or complete) from a given conversation, keeping its history as a tombstone and purging its recovery record. A goal that is actively executing must be paused first; an active goal that is not executing is paused and cleared in one auditable step.

By default, a waiting deadline is **not permission to kill a healthy task**. Without `force`, the request remains pending and continues waiting. `force: true` explicitly permits ending the process after the deadline; unfinished work is recorded first. A long tool or model request is never declared dead merely because it has been quiet for 60 seconds.

An actual pending user question can be saved without waiting indefinitely for an answer. The restart does not answer it; recovery stays in `waiting-user` until you reply.

**Stopping is different from restarting.** Use your service manager to stop DSH, for example `systemctl stop <unit>`. The compatibility tool `shutdown_harness` now explains this and performs no exit: under `Restart=always`, merely exiting would restart the service and falsely claim to have stopped it.

## Questions and approvals

The plugin recognizes DSH's `ask_user_question` calls and approval records. A synthetic “tool interrupted” result is not a human answer. Neither a goal round nor a generated “continue” counts as your reply.

After a restart, the original question remains in the conversation history and recovery status. Reply in that conversation to continue. The plugin does **not** automatically resend the question, reconstruct an expired browser dialog, or guess your selection.

Security approvals are not ordinary answers. An old `allowed-once` grant is never replayed to authorize an uncertain operation. An unresolved approval remains visible and needs a fresh decision through DSH's normal approval mechanism.

## Recovery and duplicate work

The plugin actively reads stored sessions, restores eligible original conversations through DSH's session controller, and checks current task state again before continuing. Its recovery file is retained until work is durably settled; reading the file does not consume it. A second restart or a temporary delivery failure therefore does not erase pending work.

Recovery uses stable message identities, preserves pending input order, and keeps the caller's instructions separate from other conversations. It also stops an in-progress recovery attempt if shutdown or cancellation wins a race.

**External effects are not universally exactly-once.** If a tool sent a message or deployed code immediately before a crash but its result was not saved, the outcome may be uncertain. The continuation asks the assistant to verify completed operations rather than blindly repeat them. Tools or channel adapters need their own idempotency support for stronger guarantees.

## Goals and failure reasons

An `active` goal is an ongoing task, even if the browser is closed or the gateway was restarted manually. It is restored without a “recently used” heuristic. But active does not mean ready to call the model: a goal waiting for your answer must continue waiting.

Paused, completed and blocked goals remain unchanged. Existing DSH safety limits are not bypassed. Quota or credential errors, output limits, round limits and other non-retryable conditions are reported in recovery status rather than described as successful completion. Resolve the cause and explicitly continue the task through its original conversation or goal controls.

## Settings

Set these under `dsh-keep-going` in `settings.yaml`:

```yaml
dsh-keep-going:
  drainTimeoutMs: 600000    # Initial wait: 10 minutes. Cutoff requires force:true.
  retryMinMs: 1000
  retryMaxMs: 60000
  restartExitCode: 75      # Configure the service manager to restart this code.
  restartBurstLimit: 5
  restartWindowMs: 60000
```

A burst of restarts delays recovery until the window passes; it does not delete tasks or permanently suppress their resumption. `stateDirectory` can select a separate recovery directory for an independent profile; changing it requires restarting DSH.

The old `stuckAgentMs`, `stormLimit`, `stormWindowMs` and `scanIntervalMs` settings are no longer used. In particular, silence is no longer a reason to discard a task, and there is no periodic scan interval because recovery is not periodic at all.

## Deployment and saved files

For systemd, a minimal compatible service uses:

```ini
[Service]
ExecStart=/path/to/dsh web --host 127.0.0.1 --port 3080
Restart=always
RestartSec=3
```

Alternatively configure the service to restart exit code 75 explicitly. Do not add `SuccessExitStatus=75` to an `on-failure` policy without also arranging a forced restart for that code.

Default recovery file: `$DSH_HOME/dsh-keep-going/recovery.json`. It contains pending task identities, retry state and, when needed, pending input or caller-only instructions. Newly created directories and files are private. Writes use file sync, atomic replacement and directory sync on supported systems. Invalid state is reported and preserved, not erased.

Use one DSH process per recovery directory. The store does not coordinate independent concurrent writers. The old `restart.json` and `state.json` files are not used for message delivery; stored DSH history is the source for identifying work after an upgrade.

## Chat platforms, including Feishu

This is a DSH recovery plugin, not a Feishu connector. The connector must retain the mapping from a DSH session to its original chat/thread and deliver subsequent replies there. Recovery preserves the session identity; it must not invent a new destination.

Automated tests verify distinct original chat/thread routing through a fixture and real DSH message events. **They do not call the Feishu API, prove delivery through a particular connector, or guarantee receipt of messages sent while the gateway was offline.** Those are connector-level integration checks.

## Development and verification

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
pnpm test
```

Tests use real Cordis, DSH agents, goals, question tools and local persistence. Only the model and channel adapter are deterministic fixtures. Separate test processes are killed and restarted to check recovery without browser connections, repeated interruption, stable recovery IDs, isolated caller instructions, pending questions and retries. No test touches live DSH sessions or sends external chat messages.

To run against an already installed DSH instead of downloading test dependencies:

```sh
DSH_NATIVE_TEST_RESOLVE_FROM=/path/to/install/package.json pnpm test
```

The resolver path chooses that installation's module tree. Tests fail rather than silently skipping when an explicit resolver is supplied and its dependencies are missing.

## License

MIT © 2026 Carrick
