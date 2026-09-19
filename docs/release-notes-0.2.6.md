# 0.2.6

**While DSH runs normally, this plugin provably does nothing to your conversations.**

## Why this release exists

A review asked whether non-restart activity could still reach a conversation. Auditing every path that can touch one — `restore`, `queue`/`steer`, `resumeGoal`, `flush`, `runMaintenance` — showed that all of them funnel through `recover()`, and that two of them were still reachable for a record written during normal operation:

- a record for a **queued human message** could reach the native queue and `steer()` a nudge into a live conversation whose message was already sitting in its inbox;
- a record for an **active goal** could re-arm execution that DSH itself had disarmed.

Neither needs a restart to happen, so both were interference.

## What changed

**Nothing is recorded outside a restart window.** Event capture now runs only while a requested restart is draining. Outside that window the durable session log is the only source recovery needs — a later boot re-derives whatever a crash left unfinished — so the plugin writes no records and inspects no conversation on account of ordinary activity.

**Non-restart records can never reach a conversation.** A record written while nothing was restarting (`restartScoped === false`) is dropped before any restore, queue or goal call: it is redundant with the durable log, and the boot scan re-derives the real work if the process dies. The gate sits above every send-capable path.

**The boot scan still claims them.** A provisional record no longer suppresses the restart scan that would turn it into real recovery work (`ownsContinuation` and the checkpoint's turn check now ignore provisional records), so crash recovery is unchanged: discover claims the work, then it is continued exactly once.

**Older records keep their meaning.** Records written by earlier versions carry no scope flag; they are still treated as restart work, so a pending question from an earlier restart keeps waiting for your answer instead of being discarded by the upgrade.

## Verified

New regressions:

- *steady state touches no conversation at all* — real Cordis and a real agent kernel: after ordinary turns in two conversations and 40 poll cycles, no model turn is started by the plugin, no plugin-source message exists in either transcript, goal activation is unchanged, nothing is held, no exit is requested.
- *recovery work for one conversation never spills into another* — a conversation waiting for a human answer keeps its recovery in `waiting-user` while an unrelated conversation runs its own turn; neither receives a plugin message and no extra model request happens.
- *a record made during normal operation never nudges a queued human message / never continues an open turn / never re-arms an active goal* — each asserts no queue, no steer, no goal resume, and that the redundant record is dropped.
- *a crash upgrade claims a provisional record before it can be delivered* — proves the crash path still recovers exactly once.

**158/158 tests pass**, including the two-process shipped-CLI acceptance (SIGKILL → cold restore through the real Web `SessionController`), the real workspace registry, and the real `ask_user_question` pipeline.

```sh
pnpm install --frozen-lockfile --ignore-scripts && pnpm check && pnpm test
```

## Install

```sh
dsh plugin --profile web add git+https://github.com/Carrick-K7/dsh-keep-going.git#0.2.6
```

Requires a supervisor (e.g. systemd `Restart=always`). DSH `0.1.5-rc.2` tested. GitHub-only; not published to npm.

## 中文摘要

- **正常运行期间不写任何记录**：事件采集只在"已请求的重启正在排水"时进行。窗口之外，持久会话日志本身就是恢复的唯一来源（崩溃遗留的工作在下一次启动时重新推导），因此插件不会因为普通活动而写入记录或检查任何对话。
- **非重启记录绝不可能触达对话**：`restartScoped === false` 的记录在任何 restore / queue / 目标调用之前就被丢弃——它与持久日志重复，真出事的活由启动扫描重新推导。这个判断位于所有可能"发东西"的路径之上。
- **启动扫描仍然认领它们**：临时记录不再挡住把它们变成真正恢复工作的重启扫描，崩溃恢复行为不变（先认领，再恰好继续一次）。
- **旧版记录保持原语义**：早期版本写的记录没有 scope 标记，仍按重启工作对待——上一次重启遗留的"等待回答"会继续等你回答，而不是被升级逻辑丢掉。
- 新增回归：真实 Cordis + 真实内核的"正常运行不触碰任何对话"（40 轮 poll 无额外模型请求、无插件消息、目标状态不变、无锁、不退出）、"一个对话的恢复不溢出到另一个对话"、以及"临时记录不会 nudge 排队消息 / 不会继续未结束的轮次 / 不会重新武装目标"、崩溃升级仍恰好恢复一次。
- **158/158 测试通过**。
