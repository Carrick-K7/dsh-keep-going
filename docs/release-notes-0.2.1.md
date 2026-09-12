# 0.2.1

**Stop re-arm loops.** 0.2.0 restored goals correctly, but a goal whose model provider had no registered adapter showed the failure mode in production: every driver round errored, the native driver disarmed it, and the plugin re-armed it again — about every 40 seconds, burning goal revisions. That is exactly the periodic session restarting this plugin must not do.

## Fixed in 0.2.1

- **One re-arm per restart, per goal.** A goal driver error that disarms a goal again is DSH's own lifecycle, not a reason to re-arm periodically. The next process restart is the only thing that can recover it again.
- **Missing/unregistered providers are non-retryable.** `NO_ADAPTER`-class errors are reported as blocked with the real reason (e.g. `no adapter registered for provider "token-rhythm"`) instead of being re-armed into guaranteed failure.

Verified live after deploy: the looping goal's re-arm count dropped from ~every 40s to **zero**, and is now cleanly marked `blocked: Goal round limit reached`; all other active goals were restored exactly once. 130/130 tests pass, including the new regression that a native disarm after a successful re-arm produces no further re-arm in the same process.

## 0.2.0 (this line) — restore original work after a restart, then stay out of the way

- Boot-time one-shot recovery restores unfinished original conversations through the real `SessionController`, with each session's saved provider, model and history intact. No browser needed. After recovery settles, the plugin is fully dormant — **no periodic scanning and no automatic restarting of conversations** in steady state. A user opening an old conversation is a normal action, not a restart.
- Active goals interrupted by a restart are re-armed once and handed to DSH's own goal driver; work belonging to an active goal is handed to the goal round and never receives a generic "continue".
- A task waiting for the user's answer keeps waiting: the original question is preserved verbatim, never re-dispatched and never answered by a synthetic tool closer, a goal round, or a generated continue. It resumes only when a real same-session human reply arrives. Old approvals are never replayed as `allowed-once`.
- Paused, completed and explicitly cancelled work is never revived; fork copies gain no automatic authority over the parent's work; pending human input keeps its original order.
- Durable recovery store (atomic fsync, consume-on-confirm) survives repeated crashes and temporary delivery failures, with exponential backoff and stable message identities.
- Restart control: one pending restart at a time; newly arriving input is held durably instead of cut; `force:false` never treats silence as death; restart uses exit code 75 for the supervisor; stopping is honestly left to the service manager.

## Verification

**130/130 tests pass**, including a two-process acceptance that boots the shipped CLI twice, SIGKILLs the first, and checks cold restoration through the shipped Web `SessionController` — correct providers, models, histories, one armed goal round, isolated instructions, no browser client.

```sh
pnpm install --frozen-lockfile --ignore-scripts && pnpm check && pnpm test
```

## Install

```sh
dsh plugin --profile web add git+https://github.com/Carrick-K7/dsh-keep-going.git#0.2.1
```

Requires a supervisor (e.g. systemd `Restart=always`) to start DSH again after exit. DSH `0.1.5-rc.2` tested. GitHub-only distribution; not published to npm.

## 中文摘要

**0.2.1 修掉"反复重新武装"循环**：目标驱动器报错导致解除武装时，插件不再周期性重新武装——每个目标每次重启只恢复一次；缺失/未注册的模型供应商归类为不可重试并如实标记受阻。生产实测：循环目标的 re-arm 从约 40 秒一次降为 0，并被干净地标记为"目标轮数用尽"。

**0.2.x 系列**：重启后只做一次恢复，随后完全休眠——不周期扫描、不自动重启对话；被打断的 active 目标交给原生 goal 驱动器续轮而不是收到通用"继续"；正在等用户回答的任务保留原问题、绝不代答；暂停/完成/取消的任务绝不复活；持久恢复存储可跨多次崩溃；**130/130 测试通过**（含真实 CLI 双进程 SIGKILL 验收）。
