---
description: 手动重传当前 run 的会话数据（仅内网插件环境；蓝区不可用）。
---

> **内网限定**：上传能力只存在于冻结插件 `plugins/upload/`，蓝区安装不包含，runner 也没有 `upload` 子命令。

当前环境若没有 `plugins/upload/upload-session.mjs`：

- 停止执行，并告知用户该命令在蓝区不可用；
- 不要伪造上传结果，不要修改 `.r2c/` 运行态。

内网环境请按插件 README 直接调用 `upload-session.mjs`，本命令不负责转发。
