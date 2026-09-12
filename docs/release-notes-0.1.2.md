# 0.1.2

**An active goal keeps running — across anything.**

This release writes down the rule this plugin exists to serve, and pins it with tests. No behaviour changed: 0.1.2 states the promise, so it stops being something a future change could quietly take away.

## The rule

A goal that is still `active` keeps running. A restart does not stop it, a closed window does not stop it, an idle afternoon does not stop it. Every start re-arms it — whether the restart was asked for by a conversation, typed by you, or done by the service manager, and whether or not anything was woken afterwards.

Only three things stop a goal, and this plugin never does any of them:

| Stop | By |
| --- | --- |
| you pause it | you, or the assistant on your instruction |
| it is finished | the assistant marking it complete |
| it cannot go on | DSH itself: the round limit is reached, or a round cannot even be queued (no credit, no credentials, …) |

A goal stopped that way stays stopped: "I paused this on purpose" always wins over resuming. If the reason was temporary, such as credit, ask for the goal to be resumed once that is sorted out.

## Goals and conversations are independent

They recover separately, on purpose:

- goals keep running across a restart even when no conversation was woken;
- a conversation can be woken without any goal being involved;
- making goal resumption depend on the wake list was considered and rejected — a long-running goal must not depend on whether someone happened to be watching.

## What changed in this release

- The Goals section of both READMEs now states the rule, the three stop conditions and who owns each of them, and the independence of goals and conversations.
- Two regression tests pin it: an active goal is re-armed by every start, whatever its source, with no wake note present; paused, blocked and complete goals are never brought back.
- 28 tests in total.

## Install

```sh
dsh plugin --profile web add git+https://github.com/Carrick-K7/dsh-keep-going.git
```

Then restart DSH once so the plugin is loaded.

## 中文摘要

**目标只要还是 `active`，就一直在跑。** 重启、关掉窗口、闲置都不该让它停；每次启动都会重新武装它，不管是哪个对话要求的重启、你手打的，还是服务管理器做的。只有三件事会让它停——你暂停它、助手标记完成、或 DSH 自己判定无法继续（回合数用尽、某轮排不上队，例如没额度或凭据无效）；这样停下的目标一律保持停止，插件不会擅自恢复。目标与会话是各自独立恢复的：没有会话被唤醒时目标照跑，反之亦然。本版没有改动行为，只是把这条规则写进文档并用测试钉死。
