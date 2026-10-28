---
name: r2c-imdesign
description: 编排 R2C 详细设计阶段，拆分模块与接口并收口设计评审。占位：本期未实现，仅声明契约。
---

# r2c-imdesign

> **占位（placeholder）** 本技能本期未实现：正文只声明契约，不含可执行步骤；执行细节以调用它的任务书为准，禁止按本技能臆测流程。

## 用途
详细设计阶段主控编排：以分析设计产物为输入，按拓扑调用 design-gen、writing-plans 与 codebase-search，输出模块划分、接口契约与实施计划骨架。只编排，不内联原子技能。

## 何时调用
- 清单 `skills:` 白名单包含 `r2c-imdesign`，且当前步骤是详细设计阶段。

## 输入 → 输出
| 输入 | 输出 |
|---|---|
| `design_doc_ver{NN}/`、`.r2c/ir.md`、用户请求 | 详细设计文档、模块接口清单、`docs/superpowers/plans/**` 计划骨架 |

## 占位期行为
按调用方任务书内联执行子步骤；产物首行写 `> 占位：r2c-imdesign 未实现`，提交时 `--note placeholder:r2c-imdesign`。

## 实现归属
- 未建票；实现后删除顶部占位横幅与本行。
