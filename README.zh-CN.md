# dsh-keep-going

重启 DSH，**不打断正在进行的任务**。

一次重启通常要付出代价：进程在回答中途被杀掉，而且事后没人告诉 agent 继续。`dsh-keep-going` 把这两半都补上：

1. **等**：工具或命令安排的重启/关闭不会立刻杀进程——它先等正在跑的轮次结束（有上限，且卡死的轮次会被排除），然后通过宿主自己的关闭路径请求**干净退出**。
2. **续**：退出前它会记下是哪个会话发起的（`$DSH_HOME/dsh-keep-going/restart.json`）。新进程起来后读这个标记，等会话恢复，再把继续提示 steer 进去——对话从断点接着走，不需要你再说一句话。

```
restart_harness ──▶ 等轮次结束 ──▶ 写标记 + 干净退出
                                        │
                      服务管理器（systemd Restart=always）拉起新进程
                                        │
                    新进程启动 ──▶ 读标记 ──▶ steer 会话 ──▶ 接着干
```

## 它明确不做什么

| 不在范围内 | 归谁管 |
| --- | --- |
| 拉起新进程 | 你的服务管理器——systemd `Restart=always`、Windows 服务等 |
| 坏插件集的禁用/回滚 | 你（宿主是 fail-loud，启动失败即退出） |
| 浏览器半、设置页、进程面板 | 都没有——这是个纯 host 插件 |
| 唤醒"安排重启时本来就空闲"的会话 | 有意为之：只唤醒发起者（以及当时正在跑轮次的会话） |

把范围压到这么窄是刻意的：名字只说一件事——重启之后，接着干。

## 安装

```sh
# 从 npm（发布后）
dsh plugin --profile web add dsh-keep-going

# 从本地目录
dsh plugin --profile web add /path/to/dsh-keep-going
```

然后重启一次服务让插件挂载（`systemctl restart deepseek-harness`）。

**前提**：DSH 进程必须被服务管理器监督。没有监督者，进程退出后没人拉起——见[部署](#部署)。

## 工具与命令

| 入口 | 行为 | 是否唤醒发起者 |
| --- | --- | --- |
| `restart_harness`（模型工具） | 等当前轮次结束后重启 | ✅ |
| `shutdown_harness`（模型工具） | 退出且不重启 | — |
| `cancel_harness_action`（模型工具） | 在执行前撤销已安排的动作用 | — |
| `/restart`（命令） | 等当前轮次结束后重启 | ❌（等你） |
| `/shutdown`（命令） | 退出且不重启 | — |

`restart_harness` 参数：

| 参数 | 含义 |
| --- | --- |
| `continuePrompt` | 重启后 steer 给该会话的文本，覆盖配置里的默认值 |
| `waitMs` | 本次调用的排水上限（覆盖 `drainTimeoutMs`） |
| `force` | 即使**其它**会话正在跑轮次也强行重启（默认 `false`）。不带它时调用会被拒绝并返回在飞会话列表——一个会话永远不能悄悄掐掉别人的工作 |

## 唤醒哪一个会话

只唤醒提出重启的那一个——用 `restart_harness` 时，就是发起这次工具调用的那个会话。它醒来时收到的消息，是**它自己**的指令；发给别的会话，就等于让那个会话去干别人的活。当时正在回答的其它会话不会被唤醒，也不会收到任何消息，就停在原处。

## 设置

取自 `settings.yaml` 的 `dsh-keep-going` 段，可在 GUI 里实时修改：

```yaml
dsh-keep-going:
  continuePrompt: DSH 已重启完成，请继续未完成的工作。
  drainTimeoutMs: 600000   # 10 分钟：到点就走
  stuckAgentMs: 60000      # 60 秒：running 但无活动的会话不再阻塞
  stormLimit: 5            # 窗口内退出超过 5 次 ⇒ 只重启、不唤醒
  stormWindowMs: 300000
```

两条值得记住的语义：

- **卡死跳过，未知不跳过**：`running` 且最后活动早于 `stuckAgentMs` 的 agent 不再阻塞重启；而**完全没有活动记录**的 agent 算"活着的"——所以重启绝不会因为"活动追踪还没跟上"就丢掉一个轮次。
- **到点是强制，不是取消**：`drainTimeoutMs` 到点后照样退出，且唤醒标记已经写好，被打断的会话会被续跑。重启请求**不会**被静默丢弃。

## 它拥有的文件

全部在 `$DSH_HOME/dsh-keep-going/` 下：

- `restart.json` — 退出前写入，下次启动读取后即删除
- `state.json` — 重启风暴防护用的滚动退出时刻

删掉整个目录即可"忘掉"一次待执行的唤醒。

## 部署

**systemd（Linux）**：`Restart=always` 就够了：

```ini
[Service]
ExecStart=/path/to/dsh web --host 127.0.0.1 --port 3080
Restart=always
RestartSec=3
```

因为退出是走 `ctx.appExit` 请求的，storage 会 flush、端口会释放，进程结束后服务管理器拉起的新进程就能读到标记。

**Windows / 无监督者**：需要一个会重启 `dsh` 的监督者（服务、计划任务或托盘启动器）；插件自身不拉起任何进程。

## 兼容性

基于 DSH `0.1.5-rc.2` 构建（用到 `ctx.appExit`、`ctx.agents`、`ctx.tools`、`ctx.commands`、`settings.installSection`）。可选的 `@deepseek-ai/*` peer 依赖已声明，因此版本漂移会在安装期暴露，而不是启动时静默失败。

## 开发

```sh
node --test "test/*.test.js"   # 16 个测试：纯策略 + 假上下文的冒烟启动
```

`lib/policy.js` 把所有判断（排水、卡死识别、风暴防护、标记结构）写成纯函数——这些是最值得在不起 profile 的情况下测的部分。`lib/state.js` 管那两个 JSON 文件。`lib/index.js` 把两者接进 Cordis。

## 许可证

MIT
