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

插件 hook 脚本（bin/herdr-report.js，源码 src/herdr-report.ts）通过 socket API（pane.report_agent / pane.release_agent）上报三类信息，socket 不可达时回退 CLI：

1. **状态**：UserPromptSubmit/PreToolUse/PostToolUse/PostToolUseFailure/PermissionDenied → working；Stop/idle_prompt → idle；PermissionRequest/StopFailure/权限类 Notification → blocked。相同状态去重，5 分钟心跳强制刷新。
2. **恢复命令**：SessionStart 存储 "codebuddy --resume SESSION_ID"，Herdr 服务器重启后在同一窗格恢复会话。
3. **释放**：SessionEnd 清除窗格上的 agent。

集成 source 是 "codebuddy-pro"；不得使用保留的 "herdr:" 前缀。

每窗格状态持久化在 $TMPDIR/herdr-codebuddy-pro-<pane>.json（seq/状态/会话ID/sentAt），seq 跨进程严格递增。

## 调试

用户反馈 CodeBuddy 没出现在 Herdr、或状态不对时：

1. 运行插件诊断（一次拿全信息）：
   node "$CODEBUDDY_PLUGIN_ROOT/bin/herdr-report.js" --doctor
2. 确认 HERDR_ENV=1、HERDR_PANE_ID 非空。
3. 运行 "herdr agent list" 和 "herdr pane get $HERDR_PANE_ID"。
4. 查看状态文件 $TMPDIR/herdr-codebuddy-pro-*（seq 是否递增、state 是否正确）。
5. 手动触发一次上报验证链路：
   echo '{"hook_event_name":"PreToolUse","session_id":"test"}' | node "$CODEBUDDY_PLUGIN_ROOT/bin/herdr-report.js"
   herdr pane get "$HERDR_PANE_ID"

除非用户明确要求手动覆盖，不要在模型动作中直接调用 "herdr pane report-agent"——hooks 已保持 Herdr 同步。
