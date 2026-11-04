# codebuddy-herdr-pro

让 **CodeBuddy Code** 成为 **Herdr 桌面 App** 的一等公民。

## 目的

[Herdr](https://herdr.dev) 桌面 App（`herdr-app` + 底层 `herdr-core`）是一个托管编码智能体的终端运行时：它把每个智能体放在一个终端里，在 agents 列表显示它是 `idle`（空闲）、`working`（工作中）、`blocked`（等你决策）还是 `done`（你没看时完成了），并支持 `hc wait` 之类的自动化等待。

Herdr App 判断状态的唯一依据，是程序自己通过 **OSC 7501 程序状态协议**写到终端的转义序列——按 [herdr-app `defaults/AGENTS.md`](https://github.com/herdrdev/herdr-app/blob/master/defaults/AGENTS.md) 的说法：*“Agents are terminals whose program reports a status (OSC 7501)”*。herdr-core 没有提供 `report_agent` 这类 RPC，终端输出流就是唯一通道。CodeBuddy 自己不发 OSC 7501，所以在 Herdr App 里它的状态永远是空的。

**本插件通过 CodeBuddy 的 hooks 机制，把 CodeBuddy 的真实运行状态编码成 OSC 7501 序列写入终端**，从而获得：

- agents 列表中显示准确的 `idle` / `working` / `blocked` 状态
- CodeBuddy 完成一轮或需要你决策时收到通知（`blocked` 会响铃/提醒）
- `hc wait` 等自动化能正确等到 CodeBuddy 真正空闲/阻塞
- 侧边栏标题显示当前 prompt
- 退出时清除状态记录

事件→状态映射对齐 Herdr 官方一方集成（kimi）的 `KIMI_HOOK_EVENTS`（参见 [herdrdev/herdr](https://github.com/herdrdev/herdr) `src/integration/mod.rs`），并适配 CodeBuddy 的 hook 事件。

> 本插件**只支持 Herdr 桌面 App**（herdr-core）。如果你用的是 `herdr` 终端复用器（TUI，走 socket API），本插件不适用。

## 特性

### OSC 7501 协议实现
- 完整实现规范 rev 0.3 的线格式：`ESC ] 7501 ; state=...[:app=...][:kind=...][:title=<b64>][:msg=<b64>] ESC \`。
- `title` / `msg` 用标准 base64 编码 UTF-8，遵守解码字节上限（title 192B、msg 2048B）。
- 值字符集清洗（只保留 `[A-Za-z0-9_.,+/=-]`），避免 `:` / `;` 破坏分帧。
- 整条序列超过 4096 字节时，按规范优雅降级（先丢 msg，再丢 title），绝不发非法报告。
- `blocked` 携带 `kind`（permission / question / auth），让 Herdr 区分阻塞原因。

### 找到正确的终端
- CodeBuddy 的 hook 跑在它自建的**嵌套 pty** 里，直接写 `/dev/tty` 到不了 herdr-core。reporter 向上遍历进程链，找到**最外层控制终端**（Herdr 终端真正的 pty）再写入。
- 找不到外层 pty 时回退到自身 stdout；`HERDR_PRO_OSC_TO_STDOUT=1` 可强制走 stdout（测试/特殊场景）。

### 状态准确
- **matcher 精确接线**：`PreToolUse` / `PostToolUse` / `PostToolUseFailure` 只匹配 `^AskUserQuestion$`——向用户提问时 `blocked`，答完回到 `working`。这正是官方 kimi 集成的做法。
- **事件覆盖完整**：15 个 CodeBuddy hook 事件，含 `PermissionRequest`→blocked、`PermissionDenied`→working（拒绝不结束回合）、`Elicitation`→blocked / `ElicitationResult`→working（MCP 请求输入，成对清除）、`StopFailure`→blocked（API 错误需用户决策）、`SubagentStart`/`PreCompact`→working。
- **每条 blocked 都有配对的恢复事件**：权限批准→PreToolUse(其他工具)、提问回答→PostToolUse、MCP 响应→ElicitationResult、拒绝→PermissionDenied，避免 "needs you" 卡死。
- **修正 idle_prompt 误判**：`idle_prompt` 表示回合已结束等待输入，应报 `idle`；按子串匹配 “prompt” 会误判成 `blocked` 并一直粘住。

### 轻量无状态
- herdr-core 按记录整体覆盖、进程退出自动清除 working/blocked，因此**不需要 seq、文件锁、去重或心跳**——每次 hook 只是算一下状态、写一段转义序列。
- **shell 级短路**：hooks.json 先判断 `HC_TERMINAL_SOCKET`，不在 Herdr App 内时连 Node 都不启动。
- 运行时**零 npm 依赖**，构建产物已入库。
- **绝不影响会话**：所有失败一律吞掉，hook 带 5s timeout 和 `|| true` 双保险。

### 可诊断
- `--doctor` 模式：输出环境变量、解析到的外层 tty，以及 `hc get` 里的实时 status/reported/turn。
- 19 个黑盒测试，覆盖各事件状态、blocked 恢复配对、OSC 编码、字符集清洗、长度降级、畸形输入等。
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
> - 想固定版本可追加 `#<ref>`，例如 `...codebuddy-herdr-pro#v1.3.0`。
> - 私有仓库 HTTPS 克隆可能失败，可改用本地路径安装：`codebuddy plugin add <本地目录> -y`。

### 开发模式（实时 symlink）

```bash
bash script/install-dev.sh
# 然后在 CodeBuddy 中: /reload-plugins
```

> CodeBuddy 使用基于 hash 的插件缓存，完整重启可能把符号链接换回副本——重跑一次 `script/install-dev.sh` 即可恢复。

### 环境要求

- 支持插件的 CodeBuddy Code（hooks 需 v1.16.0+）
- **Herdr 桌面 App**（herdr-app + herdr-core，提供 `hc` 与 OSC 7501 解析）
- Node.js 18+（运行时零 npm 依赖；TypeScript 仅从源码构建时需要）

## 使用

安装启用后，在 Herdr App 的终端里运行 CodeBuddy 即自动上报，无需任何配置。

查看本会话在 Herdr 中的呈现：

```
/codebuddy-herdr-pro:herdr-status
```

手动诊断：

```bash
node "$CODEBUDDY_PLUGIN_ROOT/bin/herdr-report.js" --doctor
# 或直接看 herdr-core 记录的状态
hc get $HC_TERMINAL_ID --json
```

## 事件 → 状态映射

| CodeBuddy 事件 | matcher | OSC 7501 state | 说明 |
| --- | --- | --- | --- |
| SessionStart | — | `idle` | 会话开始 |
| UserPromptSubmit | — | `working` | 另把 prompt 设为 title（base64） |
| PreToolUse（AskUserQuestion） | `^AskUserQuestion$` | `blocked` (kind=question) | 向用户提问，等待作答 |
| PreToolUse（其他工具） | — | `working` | 权限已批、工具开始执行——清除上一个 blocked |
| PostToolUse / PostToolUseFailure | `^AskUserQuestion$` | `working` | 问题已答，回到工作 |
| SubagentStart / PreCompact | — | `working` | 子代理启动 / 上下文压缩中 |
| PermissionRequest | — | `blocked` (kind=permission) | 权限对话框，msg 带工具名 |
| PermissionDenied | — | `working` | 拒绝不结束回合，模型继续 |
| Elicitation | — | `blocked` (kind=question) | MCP 工具请求用户输入 |
| ElicitationResult | — | `working` | 用户已响应 MCP 请求，工具继续 |
| Notification（permission/elicitation/decision/confirm/approval） | — | `blocked` | msg 展示待决问题 |
| Notification（idle_prompt） | — | `idle` | 回合结束等待输入 |
| Stop | — | `idle` | 一轮完成 |
| StopFailure | — | `blocked` | API 错误终止回合，需要用户决策 |
| SessionEnd | — | `clear` | 清除状态记录 |

### 状态机完整性（为什么不会卡在 "needs you"）

herdr-app 的规则是：只要状态是 `blocked`，就一直显示 "needs you"，**必须靠插件上报新状态才能清除**（herdr-core 不会自动丢弃，因为 CodeBuddy 进程没退出、也不发 OSC 133 提示符标记）。因此每条进入 blocked 的路径都配了恢复事件：

| 进入 blocked | 恢复事件 |
| --- | --- |
| PermissionRequest（权限对话框） | 批准 → PreToolUse(其他工具)→working；拒绝 → PermissionDenied→working |
| PreToolUse + AskUserQuestion（提问） | PostToolUse(AskUserQuestion)→working |
| Elicitation（MCP 请求输入） | ElicitationResult→working |
| StopFailure（API 错误） | 用户重新输入 → UserPromptSubmit→working |
| Notification（权限/决策类） | 同上对应路径 |

**兜底**：若某条路径的恢复事件因异常未触发（如权限对话框被 Esc 取消而非批准/拒绝），CodeBuddy 在 60 秒无输入后会发 `idle_prompt` 通知，插件据此上报 `idle`，自动解除卡死。

**已知限制**：CodeBuddy 没有 kimi 那样的 `Interrupt` hook 事件，且用户中断（Esc/Ctrl+C）时 `Stop` 不触发。因此中断后状态可能短暂停留在 `working`，由上述 `idle_prompt` 兜底在 60 秒内恢复为 `idle`。

## 工作原理

- CodeBuddy 触发 hook 事件；`hooks/hooks.json` 对 15 个事件接线运行 reporter（带 5s timeout 和 `|| true` 双保险，且仅在 `HC_TERMINAL_SOCKET` 存在时才启动 Node）。
- `src/herdr-report.ts` 是 TypeScript 源码；构建产物 `bin/herdr-report.js` 已入库，运行时零 npm 依赖。
- reporter 从 stdin 读取 hook JSON，`classify()` 把事件映射成状态决策，`buildOsc()` 编码成 OSC 7501 序列，`emitOsc()` 写入最外层终端 pty。
- herdr-core 从终端输出流解析 OSC 7501，更新该终端的 agent 记录；进程退出或新 shell 提示符出现时自动丢弃 working/blocked 记录。
- 非 Herdr App 环境（无 `HC_TERMINAL_SOCKET`）完全 no-op。

## 文件结构

```
codebuddy-herdr-pro/
├── .codebuddy-plugin/plugin.json   # 插件清单
├── hooks/hooks.json                # 15 个 hook 事件接线（含 matcher）
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
