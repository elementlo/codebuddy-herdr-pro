---
description: "显示当前 CodeBuddy 会话在 Herdr App 中的呈现（状态、turn、外层 tty）。"
argument-hint: "[terminal_id]"
---

如果 `HC_TERMINAL_SOCKET` 非空，说明当前运行在 Herdr 桌面 App 的终端内。请**实际运行**以下命令（不要只描述）来报告本会话的 Herdr 可见性：

```bash
# 1. 插件自带的完整诊断（环境变量、解析到的外层 tty、hc get 的实时 status）
node "$CODEBUDDY_PLUGIN_ROOT/bin/herdr-report.js" --doctor

# 2. 是否在 Herdr App 内
echo "HC_TERMINAL_SOCKET=$HC_TERMINAL_SOCKET HC_TERMINAL_ID=$HC_TERMINAL_ID"

# 3. herdr-core 记录的本终端状态
hc get "${HC_TERMINAL_ID:-}" --json
```

然后用通俗语言向用户解释：
- CodeBuddy 是否出现在 Herdr App 的 agents 列表（看 `reported` 是否为 true、`status` 是否非空）；
- 当前状态（idle / working / blocked）及 blocked 的 kind（permission / question / auth）；
- 侧边栏标题（title）是否正确显示当前 prompt；
- 若 status 为空，说明 OSC 7501 没被 herdr-core 收到，重点查 --doctor 输出的 outerTty 是否是 Herdr 终端的 pty。

如果 `HC_TERMINAL_SOCKET` 为空，告知用户 CodeBuddy 不在 Herdr App 内运行，插件处于 no-op 状态。
