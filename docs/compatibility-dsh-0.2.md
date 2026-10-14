# DSH 0.2 compatibility and recovery boundaries (0.3.0)

Plugin **0.3.0** targets DSH **0.2.0-rc.2**, Cordis **4.0.4**, and Schemastery **3.18.4**. These changes are not included in the old plugin `0.2.6` tag. No running installation, live recovery directory or service is modified by these source changes or tests.

## Protocol and lifecycle changes

- New recovery messages use producer-owned `source.kind: 'dsh-keep-going'`; DSH V4 rejects the retired `kind: 'plugin'` wrapper. One factory creates both continuations and ordered-inbox wake messages.
- Recognition also accepts historical plugin wrappers and DSH's migrated `plugin:dsh-keep-going` source. Historical message IDs are not rewritten.
- Tool results are normalized from both the old wrapper and the current first-class `role: 'tool'` message. Error results, including native `TOOL_OUTCOME_UNKNOWN` / `TOOL_NOT_STARTED` crash closers, never count as answers or completed approvals.
- Native resume notification now uses `agent/created`, with `source === 'resume'`. It reconciles only an already-owned recovery record, never discovers fresh work from an ordinary user opening a conversation.

## Recovery invariants

1. **Preparation is not execution authorization.** A planned restart writes provisional records tagged with its request ID. Canceling or failing preparation discards only those provisional records and the matching caller request. Existing recovery from an earlier boot remains intact. Exit capture or a subsequent boot can claim provisional work.
2. **Reject before side effects.** Non-restart records are rejected before inspect/restore. Archive status is fetched independently of the log cursor and checked before and after awaited restore; a cached transcript cannot override a fresh archive decision.
3. **Waiting work still observes its own answer.** Existing recovery records consume the original conversation's human replies and terminal events. Unrelated ordinary activity creates no recovery. A reply can retire an ordinary task or return an active goal to the native driver for subsequent rounds.
4. **Startup is ordered.** The boot scan precedes recovery polling. Concurrent poll callers share the in-flight promise; the public readiness promise includes the first recovery pass.
5. **Native ownership remains native.** No process launcher, replacement goal driver, silent quota retry, replayed one-time approval or unlimited re-arming is introduced.

## Settings migration — review before deploying

DSH 0.2 derives settings from volatile plugin Config fields and writes them into the active profile's plugin entry. The shipped entry ID is `keep-going`; the removed settings section was named `dsh-keep-going`.

DSH's legacy importer may rename `settings.yaml` to `settings.yaml.imported` before attempting section imports. It does not automatically map this plugin's old namespace, and a failed section import is only logged. **Do not assume your old custom settings were carried across.**

Before deploying a reviewed revision:

1. Preserve the original settings file and any imported backup. Do not delete recovery records.
2. Review the old `dsh-keep-going` values and copy the supported fields into the `keep-going` entry's `config` (or use its new settings form).
3. Keep `retryMaxMs >= retryMinMs`. `maxAttempts` is bounded to 1–10. The deprecated scan interval remains accepted but has no scheduling effect.
4. Confirm `stateDirectory` separately, retaining the same resolved directory unless intentionally migrating state. It is **not** volatile: changing it reloads the plugin; an existing store never silently switches paths.
5. Arrange deployment/reload through your normal controlled process. These changes do not authorize an automatic restart of a live service.

Hot values are read through the loader's stable references for later operations. They do not rewrite an already-issued restart deadline or an already-computed boot cooldown.

## Self-check

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check       # syntax plus strict declaration/consumer type tests
pnpm test        # pure policies, real kernel/events, settings, storage and process regressions
pnpm test:web    # mandatory real shipped CLI + SessionController cold-recovery acceptance
```

To check a separate installation, choose a module-resolution anchor under its matching dependency tree:

```sh
DSH_NATIVE_TEST_RESOLVE_FROM=/path/to/install/node_modules/.pnpm/fixture.cjs pnpm test
DSH_NATIVE_TEST_RESOLVE_FROM=/path/to/install/node_modules/.pnpm/fixture.cjs pnpm test:web
```

The anchor is used by `createRequire`; it need not itself exist. An explicit missing dependency is a failure, not an automatic skip.

The tests use temporary homes/workspaces and deterministic model adapters. Full-Web child processes bind random loopback ports, reject outbound network and never use the live GUI, live conversations or user credentials. They verify original provider/model/history, routing isolation, user-answer handling, cancellation, archive races, bounded attempts and durable recovery. They do **not** prove external channel delivery or universally exactly-once external tool effects.

## 中文摘要

- 必须适配的新协议：生产者消息来源、一等 `tool` 结果、Config volatile 设置、`agent/created` 生命周期事件。
- 已修复边界：用户回答后恢复记录不再卡住；取消重启不再授予目标执行权；归档状态不被日志缓存覆盖；不合法恢复在 restore 之前被拒绝；启动扫描与轮询按顺序执行。
- 旧 `dsh-keep-going` 设置节必须人工核对迁移到 `keep-going` entry，保留备份并单独确认恢复目录。没有自动修改线上配置或重启。
- 发布前同时执行 `pnpm check`、`pnpm test`、`pnpm test:web`；普通测试里的 opt-in Web 用例跳过，不能替代独立的必跑 Web 验收。
