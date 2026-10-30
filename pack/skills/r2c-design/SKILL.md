---
name: r2c-design
description: 编排 R2C 分析设计阶段，按拓扑收口需求与设计门禁。占位：本期未实现，仅声明契约。
---

# r2c-design

> **占位（placeholder）** 本技能本期未实现：正文只声明契约，不含可执行步骤；执行细节以调用它的任务书为准，禁止按本技能臆测流程。

## 用途
分析设计阶段主控编排：核对 IR/SR 登记，按拓扑调用 sr-miner → codebase-search / v3-kb → req-analysis → req-design → req-formal-verif → semantic-equiv，收口 DESIGN 边界门禁。只编排，不内联原子技能。

## 何时调用
- 清单 `skills:` 白名单包含 `r2c-design`，且当前步骤是分析设计阶段。

## 输入 → 输出
| 输入 | 输出 |
|---|---|
| `.r2c/ir.md`、`.r2c/sr-map.md`、用户请求 | `design_doc_ver{NN}/` 下 SPEC、骨架、AC、formal-verif 报告与刷新后的 `artifact-manifest.md` |

## 占位期行为
按调用方任务书内联执行子步骤；产物首行写 `> 占位：r2c-design 未实现（<date>）`，提交时 `--note placeholder:r2c-design`。

## 实现归属
- 未建票；实现后删除顶部占位横幅与本行。
