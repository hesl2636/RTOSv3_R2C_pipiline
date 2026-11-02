---
name: using-workflow
description: 约束 agent 按清单工作流与任务书推进步骤。占位：本期未实现，仅声明契约。
placeholder: true
---

# using-workflow

> **占位（placeholder）** 本技能本期未实现：正文只声明契约，不含可执行步骤；执行细节以调用它的任务书为准，禁止按本技能臆测流程。

## 用途
约束 agent 先读任务书再执行，按清单的步骤、门禁与交付物推进，不得绕过当前步骤。只编排，不内联原子技能。

## 何时调用
- 清单 `skills:` 白名单包含 `using-workflow`，且当前步骤需要按工作流顺序推进。

## 输入 → 输出
| 输入 | 输出 |
|---|---|
| 当前 run 的步骤、清单 `skills:` 白名单 | 按任务书完成的步骤产物 |

## 占位期行为
按调用方任务书内联执行子步骤；产物首行写 `> 占位：using-workflow 未实现（<date>）`，提交时 `--note placeholder:using-workflow`。

## 实现归属
- 未建票；实现后删除顶部占位横幅与本行。
