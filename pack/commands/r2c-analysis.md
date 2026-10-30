---
description: 手动对当前 run 运行归因分析（仅内网插件环境；蓝区不可用）。
---

> **内网限定**：归因分析只存在于冻结插件 `plugins/analysis/`，蓝区安装不包含，runner 也没有 `analysis` 子命令。

当前环境若没有 `plugins/analysis/analyze-session.mjs`：

- 停止执行，并告知用户该命令在蓝区不可用；
- 不要伪造分析结论，不要修改 `.r2c/` 运行态。

内网环境请按插件 README 直接调用 `analyze-session.mjs`，本命令不负责转发。
