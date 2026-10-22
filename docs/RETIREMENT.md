# Retirement / 停止维护

Decision date / 决定日期：2026-10-22

## Decision

**dsh-keep-going is discontinued. Version 0.3.0 is the final version.**

There will be no further feature development, compatibility work or security updates. The source and existing tags are retained as historical reference. The existing 0.3.0 tag is not moved, and no new package version is needed for this documentation-only decision. Its GitHub Release records this retirement; it is not a recommendation to install or upgrade.

This is a scope and maintenance-cost decision, not a claim that restart recovery has no value or that every implementation is unsafe. In the maintainer's deployment, automatic recovery does not justify the additional lifecycle coupling, recovery state and ongoing maintenance. Manual continuation after a restart is an accepted tradeoff. No replacement recovery subsystem is planned.

## Removal

1. Check for a pending restart or recovery operation before removal. Finish or explicitly cancel it; do not interrupt unrelated tasks or use force just to uninstall.
2. Remove the `keep-going` override from the selected profile's `cordis.patch.yml`, and remove `dsh-keep-going` from `dsh.profile.bundles` in that profile's `package.json`. Remove any separate overlay that inserts this plugin. Do not remove native session, goal or goal-driver entries, or change their existing enablement.
3. Uninstall the package from that same profile, for example `dsh plugin --profile web remove dsh-keep-going`. Check the resulting manifest, lockfile and composed profile; CLI behavior can differ by DSH version.
4. Verify the running loader has disposed the plugin. If it has not, arrange a normal service-manager restart at a safe time. Do not rely on the removed plugin to restore interrupted work, and do not launch a replacement server.
5. Only after disposal, delete the plugin's dedicated recovery directory (by default `$DSH_HOME/dsh-keep-going`; check `stateDirectory` if customized). Verify the exact path first. Do not delete DSH sessions, goals, attachments, shared storage or unrelated configuration.
6. Confirm the plugin's tools and commands are absent and the existing DSH endpoint remains healthy. Old conversation transcripts may still mention the plugin; they are history, not active configuration.

Uninstalling removes the plugin's restart/drain commands, automatic post-restart recovery and recovery-status tools. It does not uninstall the service manager or native goal driver, nor does it enable a goal driver that was already disabled. Unfinished work may need an explicit human continuation after a restart.

## 中文说明

**本项目停止演进，0.3.0 为最终版本。** 不再提供新功能、兼容性适配或安全更新。保留 Git 历史和既有标签用于查阅；不移动 0.3.0 标签，不为停止维护说明额外发一个软件包版本。对应 GitHub Release 仅记录项目终止，不建议新安装或升级。

这是极简化与维护成本的取舍，不是断言恢复能力毫无价值，也不是宣称存在已证实的普遍安全缺陷。在维护者的部署中，自动恢复的收益不足以支持继续维护额外的生命周期耦合与恢复状态。接受重启后手动继续，不另造提醒器、批量继续或替代恢复系统。

移除时先确认没有待执行重启或恢复，再清掉指定 profile 中的插件配置、bundle 声明和依赖；确认插件已从运行时卸载，必要时在安全窗口正常重启。之后才删除核实过路径的插件专属恢复目录。保留原生会话、目标历史及其现有启停设置，不强制中断其它任务，不清理共享存储或备份。
