# 0.2.5

**A scheduled restart no longer freezes DSH. Until the exit actually happens, every conversation keeps working.**

## The production failure this fixes

On 2026-09-13 the live instance (PID 239199, 0.2.3, up since 07:46) stalled for the whole deployment. One queued restart request was enough:

- `control.request()` immediately took a native maintenance lock on **every idle agent** through `agent.runMaintenance()`, and `check()` renewed those locks every 500 ms;
- a locked agent still reports `status: 'idle'` in DSH, so every conversation looked free while new messages were only latched into `inbox.nextTurn` — no model request was ever made;
- with `force: false`, reaching the deadline did not fail or release anything: it silently extended itself (`token.deadline = now() + drainTimeoutMs`). The journal shows *"restart still waiting for 3 task(s)"* at 08:05:53 and *"2 task(s)"* at 08:15:54, with the process unchanged the whole time;
- cancelling was only possible from the conversation that requested the restart, so the deployment stayed frozen as long as another session had work;
- the same day saw 435 repeated continuation deliveries, because a delivered attempt that kept failing was re-sent instead of being settled.

## What changed

**Pending is not exiting.** A request now only records durable state while it waits: no maintenance locks, no goal disarming, no frozen conversations. A message that arrives while a restart is pending starts its turn immediately.

**Locks exist only for the handover.** Once nothing is running, the plugin saves durable state *first*, then takes the locks, verifies once more that no turn started in that window, and asks DSH to exit. If work resumed, the locks are released and the request keeps waiting. A restart that waits for one long task can no longer stall anything else.

**Only `force: true` cuts running work.** At the deadline without `force`, the request keeps waiting for a quiet moment and says so in the log. With `force`, work still running at the deadline is cut only after the synchronous snapshot has recorded it, and the exit still uses the supervisor restart code.

**Cancelling leaves nothing behind.** Because a waiting request takes no locks and changes no goal activation, cancelling simply discards the record — there is no state to restore.

**No repeated deliveries.** A delivered continuation is settled by its verdict: `completed` retires the record, an unretryable ending marks it `blocked`. A receipt that belongs to an older turn than the session's newest work is retired instead of being replayed, and every automatic path (delivery exceptions, provider errors, further restart interruptions) is bounded by `maxAttempts`.

## Verified

- New regressions: a message arriving while a restart is pending starts a turn at once and is not parked in `inbox.nextTurn`; a waiting request holds no lock and does not touch goal activation; cancelling leaves no lock or goal-state change; a running turn elsewhere is never cut without `force`; `force` at the deadline exits with code 75 only after the cut work is saved; an admitted receipt for an older turn is never replayed.
- **152/152 tests pass**, including the two-process shipped-CLI acceptance (SIGKILL → cold restore through the real Web `SessionController`), the real workspace registry, and the real `ask_user_question` pipeline.

```sh
pnpm install --frozen-lockfile --ignore-scripts && pnpm check && pnpm test
```

## Install

```sh
dsh plugin --profile web add git+https://github.com/Carrick-K7/dsh-keep-going.git#0.2.5
```

Requires a supervisor (e.g. systemd `Restart=always`). DSH `0.1.5-rc.2` tested. GitHub-only; not published to npm.

## 中文摘要

- **待重启不等于正在退出**：请求等待期间只保存持久状态——不上维护锁、不解除目标武装、不冻结任何对话；等待期间到达的消息立即开轮。
- **锁只用于交接那一刻**：确认没有任务在跑后，先保存持久状态，再上锁、复核、请 DSH 退出；若期间又有任务开始，则释放锁继续等待。一个等待别的长任务的请求不会再拖住整个部署。
- **只有 `force: true` 才允许在期限到达时切断仍在运行的工作**；不带 force 时到期只记录日志并继续等安静时机。切除前先做同步快照，退出码仍是服务管理器的重启码。
- **取消不留残留**：等待期间没有任何锁和目标状态改动，取消即丢弃记录。
- **不再重复投递**：投递过的继续任务按判决结案（完成即归档、不可重试即 blocked）；属于更早轮次的回执直接收回，不再按定时器重放；所有自动路径都受 `maxAttempts` 约束。
- 生产背景：0.2.3 实例（PID 239199）因一个排队中的重启请求把全站冻结——被锁的 agent 在 DSH 里仍显示 `idle`，消息只进 `inbox.nextTurn`；`force:false` 到期只是静默续期（08:05:53“3 task(s)”、08:15:54“2 task(s)”），当天还有 435 次重复投递。
- **152/152 测试通过**，新增“等待期间消息立即开轮、等待不持锁不改目标状态、取消无残留、force 与退出码语义、旧回执不重放”等回归。
