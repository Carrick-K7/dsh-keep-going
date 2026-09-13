# 0.2.4

**Recovery now only ever answers a restart — a conversation you stopped, or one that failed while DSH was running, is left alone.**

## Why this release exists

0.2.3 could pick up work that had nothing to do with a restart. A conversation stopped by hand, or a turn that failed on provider quota, could be re-sent by the plugin on a timer — in the worst case for a provider account that had no quota left at all. That is not recovery, it is noise addressed to nobody.

## What changed

**Only a restart interruption is recoverable.** A turn ending `interrupted` (the process died mid-turn) — or a disposal this plugin recorded itself as part of its own exit — is restart work. A turn that ended `completed`, `blocked`, `max-tokens`, aborted by the user/hook/parent, disposed by an ordinary lifecycle, or failed with a provider error is not.

**Work recorded during normal operation is only a checkpoint.** The plugin still records unfinished turns while DSH runs, so a crash during one can be found; but once that turn ends without a restart, the record is retired. Nothing is sent, retried or resumed behind your back. An exit (a requested restart, a drain) upgrades the checkpoint to restart work.

**A stop you performed is final.** A session stopped by hand ends as `aborted`/`disposed` without the plugin's own exit record, so it is reported as *Stopped outside a restart* and never re-sent. Same for user cancellations.

**Quota, credit and hard request errors stop immediately.** Classification now reads the provider's message, not just the error code: `usage limit`, `余额不足`, `额度`, `配额`, `402`, and other quota wording are recognized, as are credential/adapter errors and 4xx statuses (except `408`/`429`). These end the task in `blocked` with the provider's own message instead of a retry loop.

**A failing continuation is reported, not replayed.** Once a continuation has been delivered and its turn ends, its verdict is settled: `completed` retires the record, anything unretryable marks it `blocked`. Only a further restart interruption may continue it, and one task gets at most `maxAttempts` (default **3**) automatic attempts before it is marked blocked and left for you. Transient delivery failures (queue/flush errors) still back off and retry under the same cap.

## New setting

```yaml
maxAttempts: 3   # automatic attempts per task, 1..10
```

## Evidence from this deployment

- `session-af99297f`: 16 attempts / 18 recorded failures against a provider with no registered adapter — that loop is what `credentials` classification plus the attempt cap now stop at once.
- `session-c3a2fe13`: 5 attempts / 6 failures from a `403 ... 5-hour usage limit` response — now blocked with the provider's message on the first failure.

## Tests

**148/148 pass**, including the two-process shipped-CLI acceptance (SIGKILL → cold restore through the real Web `SessionController`), the real workspace registry, the real `ask_user_question` pipeline, and new regressions for: a manual stop never being recovered, quota wording in English and Chinese, steady-state failures never becoming recovery work, bounded re-delivery across repeated restarts, and caller-request settlement (which previously re-delivered a finished request forever).

```sh
pnpm install --frozen-lockfile --ignore-scripts && pnpm check && pnpm test
```

## Install

```sh
dsh plugin --profile web add git+https://github.com/Carrick-K7/dsh-keep-going.git#0.2.4
```

Requires a supervisor (e.g. systemd `Restart=always`). DSH `0.1.5-rc.2` tested. GitHub-only; not published to npm.

## 中文摘要

- **只恢复被重启打断的工作**：`interrupted`（进程死在任务中途），或本插件自己记录的退出造成的 disposal。已完成、blocked、max-tokens、用户/钩子/父级取消、普通生命周期 disposal、提供方报错，一律不算重启遗留。
- **正常运行期间的记录只是检查点**：崩溃时仍能被发现；但该轮一旦以“非重启原因”结束，检查点就被收回，不会向你背后发送、重试或恢复任何东西。重启/排水开始时，检查点升级为重启工作。
- **手动停止是最终决定**：显示为 *Stopped outside a restart*，绝不重发；用户取消同理。
- **额度/余额/硬性 4xx 立刻停止**：识别 `usage limit`、`余额不足`、`额度`、`配额`、`402` 等中英文措辞与凭据/adapter 错误，直接标记受阻并保留提供方原始报错。
- **失败的继续任务只报告，不重放**：已完成则结案；不可重试则 blocked；只有“又一次重启打断”允许接着做，且同一任务最多自动尝试 `maxAttempts`（默认 **3**）次。投递异常仍按退避重试，同样受上限约束。
- 生产证据：`session-af99297f`（16 次尝试/18 次失败，provider 无 adapter）与 `session-c3a2fe13`（403 5-hour usage limit，5 次尝试/6 次失败）这两类循环在 0.2.4 下第一次失败即停止。
- **148/148 测试通过**，新增手动停止不恢复、中英文额度识别、正常运行失败不成任务、多次重启有上限、request 结算（此前会无限重发）等回归。
