---
name: herdr
description: 将 CodeBuddy 活动上报给 Herdr（托管编码智能体的终端复用器）。当用户提到 Herdr、希望 agent 状态显示在 Herdr 侧边栏、或要求验证/调试 CodeBuddy-Herdr 集成时使用。
---

# CodeBuddy 的 Herdr 集成

Herdr (https://herdr.dev) 是托管本 CodeBuddy 会话的终端运行时。codebuddy-herdr-pro 插件已通过 CodeBuddy hooks 自动完成上报，正常情况下你**不需要**手动调用 Herdr。本 skill 用于理解和调试该上报链路。

## 工作原理（只读参考）

Herdr 窗格内的每个进程都继承这些环境变量：

| 变量 | 含义 |
| --- | --- |
| HERDR_ENV | 在 Herdr 内为 1 |
| HERDR_PANE_ID | 本 CodeBuddy 所在窗格 |
| HERDR_BIN_PATH | 管理该窗格的 Herdr 可执行文件 |
| HERDR_SOCKET_PATH | Herdr 本地 API socket（Unix socket） |

插件 hook 脚本（bin/herdr-report.js，源码 src/herdr-report.ts）**自动识别两个 Herdr 产品并选择后端**：

- **herdr TUI**（`HERDR_ENV=1` + `HERDR_PANE_ID`）：走 socket API，不可达时回退 `herdr` CLI。
- **Herdr 桌面 App / herdr-core**（`HC_TERMINAL_SOCKET`）：herdr-core 没有 report_agent RPC，按官方 AGENTS.md，agent 状态来自程序自报的 **OSC 7501** 转义序列。reporter 向上遍历进程链找到最外层 pty（CodeBuddy hook 跑在嵌套 pty，写 /dev/tty 到不了 herdr-core），把 `ESC ] 7501 ; state=...[:app=codebuddy][:kind=...][:title=<b64>][:msg=<b64>] ESC \` 写进去。core 后端无状态（不需要 seq/锁/去重，herdr-core 按记录覆盖，进程退出自动清除）。

TUI 后端协议分层与 Herdr 官方 claude/kimi 一方集成一致：

1. **会话身份** → `pane.report_agent_session`：SessionStart 时上报 agent_session_id、agent_session_path、session_start_source（白名单 startup/resume/clear/compact/branch/new/fork/select）和 resume 命令 "codebuddy --resume SESSION_ID"。仅会话变化时发送。
2. **生命周期状态** → `pane.report_agent`：idle/working/blocked，同时携带 agent_session_id。相同状态去重，5 分钟心跳强制刷新。
3. **展示元数据** → `pane.report_metadata`：UserPromptSubmit 把 prompt 设为侧边栏标题（带 TTL）。只改展示，不夺状态权威。
4. **释放** → `pane.release_agent`：SessionEnd 清除窗格上的 agent。

事件→状态映射（对齐官方 KIMI_HOOK_EVENTS）：
- working：UserPromptSubmit、SubagentStart、PreCompact、PermissionDenied、AskUserQuestion 的 PostToolUse/PostToolUseFailure
- blocked：PermissionRequest、StopFailure、权限类 Notification、AskUserQuestion 的 PreToolUse
- idle：Stop、idle_prompt 类 Notification、SessionStart

集成 source 是 "codebuddy-pro"；不得使用保留的 "herdr:" 前缀（那是 Herdr 官方集成专用）。

TUI 后端每窗格状态持久化在 $TMPDIR/herdr-codebuddy-pro-<pane>.json（seq/状态/会话ID/sentAt），seq 用纳秒时间戳并跨进程严格递增（Herdr 忽略 seq 不大于上次已接受值的上报）。

调试时先跑 `--doctor` 看 `backend` 字段是 tui 还是 core；core 后端可用 `hc get <terminal_id> --json` 看 `status`/`reported`/`turn` 是否更新。

## 调试

用户反馈 CodeBuddy 没出现在 Herdr、或状态不对时：

1. 运行插件诊断（一次拿全信息）：
   node "$CODEBUDDY_PLUGIN_ROOT/bin/herdr-report.js" --doctor
2. 确认 HERDR_ENV=1、HERDR_PANE_ID 非空。
3. 运行 "herdr agent list" 和 "herdr pane get $HERDR_PANE_ID"。
4. 查看状态文件 $TMPDIR/herdr-codebuddy-pro-*（seq 是否递增、state 是否正确）。
5. 手动触发一次上报验证链路：
   echo '{"hook_event_name":"PreToolUse","tool_name":"AskUserQuestion","session_id":"test"}' | node "$CODEBUDDY_PLUGIN_ROOT/bin/herdr-report.js"
   herdr pane get "$HERDR_PANE_ID"

除非用户明确要求手动覆盖，不要在模型动作中直接调用 "herdr pane report-agent"——hooks 已保持 Herdr 同步。
