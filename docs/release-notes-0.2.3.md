# 0.2.3

**Archived conversations stay on the shelf; stopped goals can be removed when you decide.**

## New in this line (0.2.2 + 0.2.3)

**Archived conversations are never touched.** DSH's native archive set (`ctx.workspaceRegistry.archivedSessionIds`) is consulted at discovery, revalidation and listing. A conversation you deliberately archived keeps its unfinished work archived — no restore, no continuation, no goal re-arm, whatever happened before the restart. Recovery records for sessions that later become archived are pruned.

**`keep_going_clear_goal`** removes a goal you no longer want, through the shipped `SessionController` and `ctx.goals.clear`:

- a goal that is stopped (paused, blocked, complete) is cleared directly;
- a goal that is `active` but **not executing** is paused and then cleared, so both decisions stay auditable in the session history;
- a goal that is **actively executing** is refused — pause it first.

The conversation history and the goal's tombstone are kept; only the recovery record is purged.

**No redelivery noise.** A recovery message that is already durably queued is no longer re-sent and re-logged on every tick while the session is busy with other work.

## Verified in production on this deployment

- A goal whose model provider had no registered adapter (`no adapter registered for provider "token-rhythm"`) had been burning rounds and goal revisions in a re-arm loop under 0.2.0. After 0.2.1 the loop stopped completely; under 0.2.3 it was removed on request, leaving `pause` → `clear` in the durable log.
- Boot recovery of the same restart restored every eligible session exactly once; each interrupted conversation received at most one continuation, and the session that had an active goal was continued through the goal driver rather than a generic prompt.

## Tests

**135/135 pass**, including a two-process shipped-CLI acceptance (`SIGKILL` → cold restore through the real Web `SessionController`, correct per-session provider/model/history), the real workspace registry for archive coverage, the real `ask_user_question` pipeline, and regressions for re-arm loops, archived skip, clear-goal boundaries and pending-message quiet delivery.

```sh
pnpm install --frozen-lockfile --ignore-scripts && pnpm check && pnpm test
```

## Install

```sh
dsh plugin --profile web add git+https://github.com/Carrick-K7/dsh-keep-going.git#0.2.3
```

Requires a supervisor (e.g. systemd `Restart=always`). DSH `0.1.5-rc.2` tested. GitHub-only; not published to npm.

## 中文摘要

- **归档对话绝不被触碰**：恢复在发现、复核、列举三个阶段都读取 DSH 原生归档集合，归档的对话即使有未完成工作也保持搁置。
- **新增 `keep_going_clear_goal`**：移除不再需要的目标。已停止的可直接移除；active 但未在执行的目标先记一次暂停再移除（两步可审计）；正在执行的目标会先被拒绝。历史与 tombstone 保留，只清恢复记录。
- **不再重复投递**：已经进入队列的恢复消息不会每 500ms 重发、重记日志。
- 生产实测：空转的 `token-rhythm` 目标在 0.2.1 停止循环、0.2.3 按指令移除（日志留下 pause → clear）；同一次重启中所有符合条件的会话各恢复一次，active 目标走原生 goal 续轮。
- **135/135 测试通过**，含真实 CLI 双进程 SIGKILL 冷恢复验收。
