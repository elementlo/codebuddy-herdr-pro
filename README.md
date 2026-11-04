# codebuddy-herdr-pro

让 **CodeBuddy Code** 成为 [Herdr](https://herdr.dev) 的一等公民。

## 目的

[Herdr](https://herdr.dev) 是一个专为托管编码智能体设计的终端复用器：它把每个智能体放在一个窗格里，在侧边栏显示它是 `idle`（空闲）、`working`（工作中）还是 `blocked`（等你决策），并支持 `herdr agent wait` 之类的自动化等待。

Herdr 官方内置了 claude、codex、kimi 等智能体的集成，但不认识 CodeBuddy。没有集成时，Herdr 只能靠“读屏幕”猜测状态，既不准确，也无法在服务器重启后恢复会话。

**本插件通过 CodeBuddy 的 hooks 机制，把 CodeBuddy 的真实运行状态主动上报给 Herdr**，从而获得：

- 侧边栏与 `herdr agent list` 中显示准确的 `idle` / `working` / `blocked` 状态
- CodeBuddy 完成一轮或需要你决策时收到通知
- `herdr agent wait` 等自动化能正确等到 CodeBuddy 真正空闲/阻塞
- Herdr 服务器重启后，在同一窗格自动恢复同一个 CodeBuddy 会话
- 退出时干净释放窗格，不留残留状态

实现思路参考 [is/codebuddy-herdr](https://github.com/is/codebuddy-herdr)，但**协议规范对齐 Herdr 官方一方集成（claude / kimi）**——参见 [herdrdev/herdr](https://github.com/herdrdev/herdr) 的 `src/integration/assets/{claude,kimi}/herdr-agent-state.sh` 与 `KIMI_HOOK_EVENTS`。

### 同时支持两个 Herdr 产品

Herdr 有两个形态，状态上报机制完全不同，本插件**自动识别环境并选择对应后端**：

| | herdr TUI（终端复用器） | Herdr 桌面 App（herdr-app + herdr-core） |
| --- | --- | --- |
| 识别依据 | `HERDR_ENV=1` + `HERDR_PANE_ID` | `HC_TERMINAL_SOCKET` |
| 上报通道 | 本地 socket API（`pane.report_agent` 等） | **OSC 7501** 程序状态转义序列写入终端 pty |
| CLI | `herdr` | `hc` |

桌面 App 的 herdr-core 没有 `report_agent` 这类 RPC——按 [herdr-app `defaults/AGENTS.md`](https://github.com/herdrdev/herdr-app/blob/master/defaults/AGENTS.md)，*“Agents are terminals whose program reports a status (OSC 7501)”*。因此 core 后端把状态编码成 OSC 7501 序列（`state` / `app` / `kind` / `title` / `msg`）写到终端。两个后端都不在时，插件完全 no-op。

## 特性

### 双后端自动适配
- **herdr TUI**：socket API 分层上报（见下）。
- **Herdr 桌面 App / herdr-core**：OSC 7501 程序状态协议。reporter 会向上遍历进程链找到**最外层 pty**（CodeBuddy 的 hook 跑在嵌套 pty 里，直接写 `/dev/tty` 到不了 herdr-core），把转义序列写进去。
- 环境识别、状态映射、去重/心跳策略对两个后端一致；core 后端无状态（herdr-core 自己按记录覆盖，进程退出自动清除）。

### 对齐官方协议规范
- **会话身份与生命周期状态分离**：和官方 claude/kimi 集成一样，用 `pane.report_agent_session` 上报会话身份（`agent_session_id` / `agent_session_path` / `session_start_source` / `resume_argv`），用 `pane.report_agent` 上报状态，而不是把两者混在一个请求里。
- **`session_start_source` 白名单校验**：按 Herdr `normalize_session_start_source` 的取值（startup/resume/clear/compact/branch/new/fork/select）过滤，避免上报被丢弃。
- **展示元数据走 `pane.report_metadata`**：把用户 prompt 设为侧边栏标题（带 TTL）。官方文档明确元数据只改展示、不夺取状态权威，因此不会干扰 `herdr agent wait`。
- **source 命名合规**：使用 `codebuddy-pro`，不占用 Herdr 保留的 `herdr:` 前缀。

### 状态准确
- **matcher 精确接线**：`PreToolUse` / `PostToolUse` / `PostToolUseFailure` 只匹配 `^AskUserQuestion$`——向用户提问时 `blocked`，答完回到 `working`。这正是官方 kimi 集成的做法。
- **事件覆盖完整**：13 个 CodeBuddy hook 事件，含 `PermissionRequest`→blocked、`PermissionDenied`→working（拒绝不结束回合）、`StopFailure`→blocked（API 错误需用户决策）、`SubagentStart`/`PreCompact`→working。
- **修正 idle_prompt 误判**：`idle_prompt` 表示回合已结束等待输入，应报 `idle`；按子串匹配 “prompt” 会误判成 `blocked` 并一直粘住。

### 高性能
- **状态去重**：状态未变化时直接跳过 socket 写入，长回合可省掉数十次无意义 IPC。
- **零子进程锁**：基础集成每次上报都要 `spawnSync("flock", ...)` 再拉起一个 Node 子进程算 seq（每次 hook 至少 2 个额外进程，且 `flock` 在 Windows 不存在）。本版用 `O_EXCL` 原子创建锁文件 + 进程内自旋（`Atomics.wait`），**不 spawn 任何进程**，跨平台可用。
- **省掉泛化 PreToolUse hook**：UserPromptSubmit 已把回合标记为 working，泛化 PreToolUse 会为每次工具调用白白拉起一个 node 进程却不改变状态。
- **shell 级短路**：hooks.json 先判断 `HERDR_ENV`，不在 Herdr 内时连 Node 都不启动。
- **CLI 回退异步化**：回退到 Herdr CLI 时用 detached + unref 子进程，不阻塞 hook 返回。

### 高可用
- **socket → CLI 双通道**：`HERDR_SOCKET_PATH` 不可达时自动回退 `HERDR_BIN_PATH`（回退前先探测二进制可运行，避免静默吞掉所有上报）。
- **心跳刷新**：状态超过 5 分钟未变化时强制重报一次——Herdr 服务器重启清空 agent 记录后，长会话无需等待下一次状态切换即可重新出现在侧边栏。
- **崩溃自愈**：锁文件带 stale 检测（5s），reporter 被 kill 不会永久卡死窗格；状态文件用 temp + rename 原子写。
- **resume 命令预校验**：按 Herdr 规则（首词为 PATH 命令名、无撇号/控制字符、≤64 参数、≤8KiB）本地校验，避免 `invalid_resume_argv` 拒绝。
- **session_id 记忆**：后续事件即使不带 session_id，也会沿用 SessionStart 记录的会话 ID 持续携带 resume 命令。
- **绝不影响会话**：所有失败一律吞掉，hook 带 5s timeout 和 `|| true` 双保险；非 Herdr 环境完全 no-op。

### 可诊断
- `--doctor` 模式：一条命令输出环境变量、持久化状态、socket 可达性、`herdr agent list` / `herdr pane get` 结果。
- 16 个黑盒测试（自建假 Herdr socket 服务器），覆盖协议分层、去重、seq 单调性、回退、畸形输入等。
- GitHub Actions CI：Node 18/20/22 矩阵 + 构建产物一致性检查。

## 安装

### 常规安装

```bash
codebuddy plugin add https://github.com/elementlo/codebuddy-herdr-pro -y
codebuddy plugin enable codebuddy-herdr-pro
```

然后在 CodeBuddy 中执行 `/reload-plugins`（或开一个新会话）生效。

> - 不需要 `.git` 后缀，CodeBuddy 会自动把 URL 当作 git 仓库处理。
> - 插件安装后 ID 形如 `codebuddy-herdr-pro@git-<hash>`，**默认是禁用的**，必须执行上面的 `plugin enable`。
> - 想固定版本可追加 `#<ref>`，例如 `...codebuddy-herdr-pro#v1.1.0` 或 `...codebuddy-herdr-pro#main`。

也可以从本地路径或其他 git 仓库安装：

```bash
codebuddy plugin add <path-or-repo> -y
codebuddy plugin enable codebuddy-herdr-pro
```

### 开发模式（实时 symlink）

本地开发时用 `script/install-dev.sh`，它会把 CodeBuddy 的缓存副本和 package-sources 副本都替换成指向源码目录的符号链接，改完代码 `/reload-plugins` 即可生效：

```bash
bash script/install-dev.sh
# 然后在 CodeBuddy 中: /reload-plugins
```

> CodeBuddy 使用基于 hash 的插件缓存，完整重启可能把符号链接换回副本——重跑一次 `script/install-dev.sh` 即可恢复。

### 环境要求

- 支持插件的 CodeBuddy Code（hooks 需 v1.16.0+）
- **herdr TUI** 0.9+ 运行该窗格（resume 命令需 0.9.2+；旧版会忽略 resume，状态上报照常工作），**或 Herdr 桌面 App**（herdr-app + herdr-core，走 OSC 7501）
- Node.js 18+（运行时**零 npm 依赖，不需要 flock**；TypeScript 仅从源码构建时需要）

## 使用

安装启用后，在任何 Herdr 窗格内自动上报，无需任何配置。

查看本会话在 Herdr 中的呈现：

```
/codebuddy-herdr-pro:herdr-status
```

手动诊断：

```bash
node "$CODEBUDDY_PLUGIN_ROOT/bin/herdr-report.js" --doctor
```

验证恢复能力（不影响日常会话，用独立命名会话测试）：

```bash
herdr --session codebuddy-test      # 在某个窗格里跑 CodeBuddy
herdr session stop codebuddy-test
herdr --session codebuddy-test      # 窗格应自动执行 resume 命令并重新上报
```

## 事件 → 状态映射

| CodeBuddy 事件 | matcher | Herdr 状态 | 说明 |
| --- | --- | --- | --- |
| SessionStart | — | `idle` | 经 `pane.report_agent_session` 上报会话身份 + `codebuddy --resume <id>` + `session_start_source` |
| UserPromptSubmit | — | `working` | 另经 `pane.report_metadata` 把 prompt 设为侧边栏标题（仅展示，带 TTL） |
| PreToolUse | `^AskUserQuestion$` | `blocked` | 向用户提问，等待作答 |
| PostToolUse / PostToolUseFailure | `^AskUserQuestion$` | `working` | 问题已答，回到工作 |
| SubagentStart / PreCompact | — | `working` | 子代理启动 / 上下文压缩中 |
| PermissionRequest | — | `blocked` | 权限对话框，message 带工具名 |
| PermissionDenied | — | `working` | 拒绝不结束回合，模型继续 |
| Notification（permission/elicitation/decision/confirm/approval） | — | `blocked` | message 展示待决问题 |
| Notification（idle_prompt） | — | `idle` | 回合结束等待输入 |
| Stop | — | `idle` | 一轮完成 |
| StopFailure | — | `blocked` | API 错误终止回合，需要用户决策 |
| SessionEnd | — | release | 清除窗格上的 agent |

## 工作原理

- CodeBuddy 触发 hook 事件；`hooks/hooks.json` 对 13 个事件接线运行 reporter（带 5s timeout 和 `|| true` 双保险）。
- `src/herdr-report.ts` 是 TypeScript 源码；构建产物 `bin/herdr-report.js` 已入库，运行时零 npm 依赖。
- reporter 从 stdin 读取 hook JSON，优先通过 **Herdr 本地 socket API**（`HERDR_SOCKET_PATH`，newline-delimited JSON）上报，失败回退 CLI。协议分层与官方 claude/kimi 集成一致：
  - `pane.report_agent_session` — 会话身份，仅会话变化时发送
  - `pane.report_agent` — 生命周期状态（idle/working/blocked），同时携带 `agent_session_id` 帮助 Herdr 绑定会话
  - `pane.report_metadata` — 侧边栏标题等**纯展示**字段（带 TTL），不夺取状态权威
  - `pane.release_agent` — 退出释放
- 每窗格一个状态文件（`$TMPDIR/herdr-codebuddy-pro-<pane>.json`）持久化 seq / 状态 / 会话 ID，保证跨进程 seq 严格递增（Herdr 会忽略 seq 不大于上次已接受值的上报）。seq 用纳秒时间戳，与官方 kimi 集成的 `time.time_ns()` 同思路。
- **herdr-core 后端**：检测到 `HC_TERMINAL_SOCKET` 时，把状态编码为 OSC 7501 序列（`ESC ] 7501 ; state=<idle|working|blocked|clear>[:app=codebuddy][:kind=permission|question|auth][:title=<b64>][:msg=<b64>] ESC \`）写入最外层终端 pty。herdr-core 从终端输出流解析，无需 socket/seq/锁。
- 两个后端都不在（`HERDR_ENV != 1` 且无 `HC_TERMINAL_SOCKET`）时完全 no-op。

## 文件结构

```
codebuddy-herdr-pro/
├── .codebuddy-plugin/plugin.json   # 插件清单
├── hooks/hooks.json                # 13 个 hook 事件接线（含 matcher）
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

## License

MIT
