---
name: all-multirepo-upload
description: 向多仓上传构件并回填上传回执。占位：本期未实现，仅声明契约。
placeholder: true
---

# all-multirepo-upload

> **占位（placeholder）** 本技能本期未实现：正文只声明契约，不含可执行步骤；执行细节以调用它的任务书为准，禁止按本技能臆测流程。

## 用途
向多个目标仓库上传构件并回填上传回执。工具不可用时如实报告，禁止伪造回执。

## 何时调用
- 清单 `skills:` 白名单包含 `all-multirepo-upload`，且当前步骤需要多仓上传。

## 输入 → 输出
| 输入 | 输出 |
|---|---|
| 构件、目标仓库配置 | 上传回执 |

## 占位期行为
不得伪造执行结果；工具不可用时如实报「all-multirepo-upload 不可用」，交由 gate/expect 判定（通常是 exit 3 → paused）。

## 实现归属
- 未建票；实现后删除顶部占位横幅与本行。
