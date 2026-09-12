# 0.1.1

**Restart DSH, then carry on.** The answer being written is finished before DSH closes, DSH closes in an orderly way for the service manager to replace, and the conversations the restart interrupted pick their work back up — including long-running goals.

## What changed in 0.1.1

**Long-running goals come back by themselves.** DSH switches a session's goal off every time the session starts, so after a restart a goal that had been working would sit idle until someone asked again. A goal that is still `active` when its session returns is now re-armed, and the work continues on its own. Goals that were paused, blocked or completed on purpose are left untouched, and a goal that cannot be resumed (its rounds are used up, for example) is logged and left as it was.

**Every interrupted conversation is woken, each with the right message.** The conversation that asked for the restart receives its own instruction; every other conversation whose answer was cut off receives a neutral "carry on" notice that names no task, so it decides for itself what it was doing. Conversations that were already idle are not woken.

## What it does

| | |
| --- | --- |
| Tools the assistant can use | `restart_harness`, `shutdown_harness`, `cancel_harness_action` |
| Commands you can type | `/restart`, `/shutdown` |
| Settings | `continuePrompt`, `drainTimeoutMs`, `stuckAgentMs`, `stormLimit`, `stormWindowMs` |

A restart waits for the answers in progress, with a limit: when `drainTimeoutMs` passes it closes anyway, and the note that wakes the conversation is already written. A conversation marked as running that has shown no activity for `stuckAgentMs` stops holding up the restart. More than `stormLimit` restarts inside `stormWindowMs` stops the waking, not the restarting.

## Not in scope

Starting DSH again after it closes is the service manager's job (systemd `Restart=always`, a Windows service, …). Undoing a plugin installation that stops DSH from starting is your job: DSH reports the error and exits. There is no settings page and no browser button.

## Install

```sh
dsh plugin --profile web add git+https://github.com/Carrick-K7/dsh-keep-going.git
```

Then restart DSH once so the plugin is loaded.

## Verification

Tested against DSH `0.1.5-rc.2`, on a live deployment:

- two real restarts through systemd, with the conversations woken afterwards;
- a hand-written wake note, to prove the wake path independently of the exit path;
- the goal behaviour above, first with a throwaway probe plugin and then with this plugin's own code in production;
- 26 unit and smoke tests (`node --test "test/*.test.js"`), including a full arm → wake-note → next-start cycle.

Three defects were found by running it for real and are fixed in this line: a missing service declaration that crashed DSH at startup, a wake message that leaked from one conversation into others, and the over-correction that briefly stopped waking interrupted conversations at all.

## 中文摘要

重启 DSH 时不丢正在进行的活儿：先把正在写的回答写完，再让 DSH 按正常流程收尾退出，由服务管理器拉起新进程；被这次重启打断的会话会被唤醒接着干（发起者收到自己的提示，其它会话收到中立的"请继续"），重启前处于 `active` 的长任务目标会自动恢复。0.1.1 新增的正是最后这一条。针对 DSH `0.1.5-rc.2` 实测：两次真实重启、一次手工唤醒验证、26 个测试全部通过。
