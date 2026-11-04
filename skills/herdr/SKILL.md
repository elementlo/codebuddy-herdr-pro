---
name: herdr
description: 将 CodeBuddy 活动上报给 Herdr 桌面 App（herdr-app + herdr-core）。当用户提到 Herdr、希望 agent 状态显示在 Herdr App 的 agents 列表、或要求验证/调试 CodeBuddy-Herdr 集成时使用。
---

# CodeBuddy 的 Herdr App 集成

Herdr 桌面 App（https://herdr.dev）是托管本 CodeBuddy 会话的终端运行时，底层是 herdr-core（CLI 为 `hc`）。codebuddy-herdr-pro 插件已通过 CodeBuddy hooks 自动完成上报，正常情况下你**不需要**手动调用。本 skill 用于理解和调试该上报链路。

> 本插件只支持 Herdr 桌面 App（herdr-core，OSC 7501）。不支持 `herdr` TUI（socket API）。

## 工作原理（只读参考）

Herdr App 的终端进程继承这些环境变量：

| 变量 | 含义 |
| --- | --- |
| HC_TERMINAL_SOCKET | herdr-core 的本地 socket（存在即表示在 Herdr App 内） |
| HC_TERMINAL_ID | 本终端地址，如 t1 |
| HC_SCOPE | 会话作用域 |

herdr-core **没有** report_agent 这类 RPC。按官方 AGENTS.md，agent 状态来自程序自报的 **OSC 7501** 转义序列，herdr-core 从终端输出流解析。插件 hook 脚本（bin/herdr-report.js，源码 src/herdr-report.ts）：

1. 从 stdin 读 hook JSON，`classify()` 映射事件→状态。
2. `buildOsc()` 编码为 `ESC ] 7501 ; state=<idle|working|blocked|clear>[:app=codebuddy][:kind=permission|question|auth][:title=<b64>][:msg=<b64>] ESC \`。
3. `emitOsc()` 向上遍历进程链找到**最外层 pty**（CodeBuddy hook 跑在嵌套 pty，写 /dev/tty 到不了 herdr-core），把序列写进去。

事件→状态：
- working：UserPromptSubmit、SubagentStart、PreCompact、PermissionDenied、AskUserQuestion 的 PostToolUse/PostToolUseFailure
- blocked：PermissionRequest(kind=permission)、AskUserQuestion 的 PreToolUse(kind=question)、StopFailure、权限类 Notification
- idle：SessionStart、Stop、idle_prompt 类 Notification
- clear：SessionEnd

herdr-core 按记录整体覆盖，进程退出自动清除 working/blocked，因此插件**无状态**（不需要 seq/锁/去重/心跳）。

## 调试

用户反馈 CodeBuddy 没出现在 Herdr App、或状态不对时：

1. 运行插件诊断（输出环境变量、解析到的外层 tty、hc get 的实时 status）：
   node "$CODEBUDDY_PLUGIN_ROOT/bin/herdr-report.js" --doctor
2. 确认在 Herdr App 内：`echo $HC_TERMINAL_SOCKET $HC_TERMINAL_ID`（非空）。
3. 看 herdr-core 记录的状态：`hc get $HC_TERMINAL_ID --json`，检查 `status` / `reported` / `turn`。
4. 手动触发一次上报验证链路：
   echo '{"hook_event_name":"PreToolUse","tool_name":"AskUserQuestion"}' | node "$CODEBUDDY_PLUGIN_ROOT/bin/herdr-report.js"
   hc get "$HC_TERMINAL_ID" --json
5. 若 status 不更新，多半是外层 tty 没找对——用 --doctor 看 outerTty 是否是 Herdr 终端的 pty。

除非用户明确要求，不要在模型动作中手动写 OSC 7501——hooks 已保持同步。
