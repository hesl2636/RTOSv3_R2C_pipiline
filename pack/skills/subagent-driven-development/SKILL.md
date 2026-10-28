---
name: subagent-driven-development
description: 编排子代理并行开发与产物合并。占位：本期未实现，仅声明契约。
---

# subagent-driven-development

> **占位（placeholder）** 本技能本期未实现：正文只声明契约，不含可执行步骤；执行细节以调用它的任务书为准，禁止按本技能臆测流程。

## 用途
把计划拆成可独立执行的子任务，为每个子代理准备上下文与验收点，汇总产物并处理冲突。只编排，不代替子代理实现。

## 何时调用
- 清单 `skills:` 白名单包含 `subagent-driven-development`，且当前步骤可拆分为并行子任务。

## 输入 → 输出
| 输入 | 输出 |
|---|---|
| 计划任务列表、共享接口约定 | 子代理产物、合并说明与冲突清单 |

## 占位期行为
按调用方任务书内联执行子步骤；产物首行写 `> 占位：subagent-driven-development 未实现`，提交时 `--note placeholder:subagent-driven-development`。

## 实现归属
- 未建票；实现后删除顶部占位横幅与本行。
