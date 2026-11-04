---
description: "显示当前 CodeBuddy 会话在 Herdr 中的呈现（状态、resume 命令、agent 列表）。"
argument-hint: "[pane_id]"
---

如果 `HERDR_ENV=1`，说明当前运行在 Herdr 窗格内。请**实际运行**以下命令（不要只描述）来报告本会话的 Herdr 可见性：

```bash
# 1. 插件自带的完整诊断（环境变量、持久化状态、socket 可达性、agent list、pane get）
node "$CODEBUDDY_PLUGIN_ROOT/bin/herdr-report.js" --doctor

# 2. 是否在 Herdr 内
echo "HERDR_ENV=$HERDR_ENV PANE=$HERDR_PANE_ID"

# 3. 全部窗格的 agent 列表
herdr agent list

# 4. 本窗格原始状态与存储的 resume 命令
herdr pane get "${HERDR_PANE_ID:-}"
```

然后用通俗语言向用户解释：
- CodeBuddy 是否出现在 Herdr 侧边栏；
- 当前状态（idle / working / blocked）及 blocked 原因；
- 是否已存储 resume 命令（Herdr 重启后可恢复本会话）；
- Herdr 报告的任何恢复错误（如 resume_not_accepted / invalid_resume_argv）。

如果 `HERDR_ENV` 不是 `1`，告知用户 CodeBuddy 不在 Herdr 内运行，插件处于 no-op 状态。
