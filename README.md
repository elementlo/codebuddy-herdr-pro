# codebuddy-herdr-pro

让 **CodeBuddy Code** 成为 [Herdr](https://herdr.dev)（托管编码智能体的终端复用器）中的一等公民。

本插件通过 CodeBuddy hooks 将实时状态上报给 Herdr，使 Herdr 侧边栏、`herdr agent list`、`herdr agent wait` 准确反映 CodeBuddy 正在做什么；同时存储可恢复的会话命令（Herdr 服务器重启后自动恢复会话），并在退出时干净地释放窗格。

基于 [is/codebuddy-herdr](https://github.com/is/codebuddy-herdr) 的思路重写，在**质量、可用性、性能**三方面做了系统性增强。

## 相比基础版的增强

### 性能
- **状态去重（dedup）**：连续 PreToolUse/PostToolUse 事件不再重复上报——状态未变化时直接跳过 socket 写入，长回合可省掉数十次无意义 IPC。
- **零子进程锁**：基础版每次上报都要 `spawnSync("flock", ...)` 再拉起一个 Node 子进程算 seq（每次 hook 至少 2 个额外进程，且 flock 在 Windows 不存在）。本版用 `O_EXCL` 原子创建锁文件 + 进程内自旋（`Atomics.wait`），**不 spawn 任何进程**，跨平台可用。
- **shell 级短路**：hooks.json 中先判断 `HERDR_ENV`，不在 Herdr 内时连 Node 都不启动。
- **CLI 回退异步化**：socket 失败回退到 Herdr CLI 时用 detached + unref 子进程，不阻塞 hook 返回。

### 可用性
- **socket → CLI 双通道**：`HERDR_SOCKET_PATH` 不可达时自动回退 `HERDR_BIN_PATH` CLI（回退前先探测二进制可运行，避免静默吞掉所有上报）。
- **心跳刷新**：状态超过 5 分钟未变化时强制重报一次——Herdr 服务器重启清空 agent 记录后，长会话无需等待下一次状态切换即可重新出现在侧边栏。
- **崩溃自愈**：锁文件带 stale 检测（5s），reporter 被 kill 不会永久卡死窗格；状态文件用 temp+rename 原子写。
- **resume 命令预校验**：按 Herdr 规则（首词为 PATH 命令名、无撇号/控制字符、≤64 参数、≤8KiB）本地校验，避免 `invalid_resume_argv` 拒绝。
- **session_id 记忆**：后续事件即使不带 session_id，也会沿用 SessionStart 记录的会话 ID 持续携带 resume 命令。

### 事件覆盖与状态准确性
| CodeBuddy 事件 | Herdr 状态 | 说明 |
| --- | --- | --- |
| SessionStart | `idle` | 强制上报 + 存储 `codebuddy --resume <session_id>` |
| UserPromptSubmit / PreToolUse / PostToolUse / PostToolUseFailure | `working` | 去重，仅状态变化时发送 |
| PermissionRequest | `blocked` | 权限对话框，message 带上工具名 |
| PermissionDenied | `working` | 拒绝不结束回合，模型继续 |
| Notification (permission/elicitation/decision/confirm/approval) | `blocked` | message 展示待决问题 |
| Notification (idle_prompt) | `idle` | 修正按子串误判为 blocked 的边界 |
| Stop | `idle` | |
| StopFailure | `blocked` | API 错误终止回合，需要用户决策 |
| SessionEnd | release | 清除窗格上的 agent |

### 可诊断性
- `--doctor` 模式：一条命令输出环境变量、持久化状态、socket 可达性、`herdr agent list` / `herdr pane get` 结果。
- 11 个黑盒单元测试（假 Herdr socket 服务器），覆盖去重、seq 单调性、回退、畸形输入等。

## 安装

```bash
codebuddy plugin add https://github.com/elementlo/codebuddy-herdr-pro -y
codebuddy plugin enable codebuddy-herdr-pro
```

然后在 CodeBuddy 中执行 `/reload-plugins`（或开新会话）生效。

> 固定版本可追加 `#<ref>`，如 `...codebuddy-herdr-pro#v1.0.0`。

### 开发模式（实时 symlink）

```bash
bash script/install-dev.sh
# 然后在 CodeBuddy 中: /reload-plugins
```

## 使用

安装启用后，在任何 Herdr 窗格内自动上报，无需配置。检查本会话在 Herdr 中的呈现：

```
/codebuddy-herdr-pro:herdr-status
```

手动诊断：

```bash
node "$CODEBUDDY_PLUGIN_ROOT/bin/herdr-report.js" --doctor
```

## 工作原理

- CodeBuddy 触发 hook 事件；`hooks/hooks.json` 对 11 个事件运行 reporter（带 5s timeout 和 `|| true` 双保险）。
- `src/herdr-report.ts` 是 TypeScript 源码；构建产物 `bin/herdr-report.js` 已入库，运行时**零 npm 依赖**。
- reporter 从 stdin 读取 hook JSON，优先通过 **Herdr 本地 socket API**（`HERDR_SOCKET_PATH`，newline-delimited JSON：`pane.report_agent` / `pane.release_agent`）上报，失败回退 CLI。
- 每窗格一个状态文件（`$TMPDIR/herdr-codebuddy-pro-<pane>.json`）持久化 seq/状态/会话 ID，保证跨进程 seq 严格递增（Herdr 会忽略 seq 不大于上次已接受值的上报）。
- 集成 source 为 `codebuddy-pro`（稳定、唯一、不占用保留的 `herdr:` 前缀）。
- 非 Herdr 环境（`HERDR_ENV != 1`）完全 no-op。

## 文件结构

```
codebuddy-herdr-pro/
├── .codebuddy-plugin/plugin.json   # 插件清单
├── hooks/hooks.json                # 11 个 hook 事件接线
├── src/herdr-report.ts             # TypeScript 源码
├── bin/herdr-report.js             # 预构建产物（hooks 实际运行）
├── commands/herdr-status.md        # /codebuddy-herdr-pro:herdr-status
├── skills/herdr/SKILL.md           # 调试参考 skill
├── script/install-dev.sh           # 开发模式安装脚本
├── test/reporter.test.mjs          # 黑盒测试（node:test）
└── .github/workflows/ci.yml        # CI: check + build + test
```

## 从源码构建

```bash
npm ci
npm run build   # tsc -> bin/herdr-report.js
npm test        # build + node --test
```

## 要求

- 支持插件的 CodeBuddy Code（hooks 需 v1.16.0+）
- Herdr 0.9+（resume 命令需 0.9.2+；旧版忽略 resume，状态上报照常）
- Node.js 18+（无其他运行时依赖，**不需要 flock**）

## License

MIT
