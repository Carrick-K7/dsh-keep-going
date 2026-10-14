# 0.3.0 — DSH 0.2 compatibility and recovery correctness

## Breaking compatibility change

This version targets **DSH 0.2.0-rc.2**, **Cordis 4.0.4** and **Schemastery 3.18.4**. It no longer supports the old DSH 0.1 settings API. Review [the migration guide](compatibility-dsh-0.2.md) before deploying.

- Settings now use volatile Config fields on the `keep-going` profile entry, rather than `settings.installSection` and the old `dsh-keep-going` settings section.
- Preserve old settings and imported backups; manually verify custom values and the recovery directory. `stateDirectory` is not hot-editable.
- Publication does not update an installed plugin or restart a running DSH service.

## Fixed

- Emit producer-owned recovery message sources accepted by session format V4; recognize current, legacy and migrated provenance without changing message identities.
- Read first-class tool-role results as well as historical wrappers. Synthetic crash failures never count as answers or completed approvals.
- Use the current `agent/created` lifecycle event.
- Resume waiting recovery after an actual human reply, including later native goal rounds, without creating work for unrelated conversations.
- Keep restart preparation provisional. Canceling or failing a restart removes only its own records, including late checkpoint results, and cannot re-arm an unrelated stopped goal.
- Refresh archive status independently of transcript caches, checking before and after restore.
- Reject unauthorized recovery before restoring a session.
- Complete startup discovery before polling; concurrent poll callers share the same in-flight pass.

## Verification

- Syntax checks and strict TypeScript declaration/consumer checks.
- **189 tests passed, zero failures and zero skips** with the DSH 0.2.0-rc.2 runtime and full-Web tests enabled during pre-release verification.
- Real shipped CLI cold recovery after both **SIGKILL** and **SIGTERM**, with the actual SessionController and settings service.
- Original model/provider/history isolation, exactly the expected recovered conversations, goal rounds, cancellation and archive races.
- The full-Web acceptance also passed against the repository's locked dependencies. CI now runs `pnpm test:web` explicitly, in addition to ordinary tests.

All recovery tests use isolated temporary homes/workspaces and deterministic model adapters. They do not access live sessions, user credentials or external chat services. No claim of universally exactly-once external tool effects is made.

## Install

```sh
dsh plugin --profile web add git+https://github.com/Carrick-K7/dsh-keep-going.git#0.3.0
```

A service manager must restart DSH when it exits. Arrange installation and service restart separately through your normal deployment process.

## 中文摘要

- 升级到 DSH 0.2 协议：消息来源、工具结果、动态设置和生命周期事件。
- 修复回答后不续轮、取消重启误激活、归档缓存失效、恢复前检查和启动并发问题。
- 发布前全量验收 **189/189 通过，零跳过**，包含 SIGKILL/SIGTERM 后真实 CLI 冷恢复。
- 旧设置节须人工核对迁移到 `keep-going` entry；保留备份，单独确认恢复目录。
- 推送版本不等于部署；不会自动修改线上安装或重启服务。
