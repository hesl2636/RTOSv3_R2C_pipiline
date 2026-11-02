---
name: r2c-implement-redblue
description: 编排 R2C 编码实现阶段，组织红蓝实现与自测并收口实施门禁。占位：本期未实现，仅声明契约。
placeholder: true
---

# r2c-implement-redblue

> **占位（placeholder）** 本技能本期未实现：正文只声明契约，不含可执行步骤；执行细节以调用它的任务书为准，禁止按本技能臆测流程。

## 用途
编码实现阶段主控编排：按计划分派红蓝双方实现任务，约束改动边界，汇总构建与自测结果，收口 IMPLEMENT 完成门禁。只编排，不内联原子技能。

## 何时调用
- 清单 `skills:` 白名单包含 `r2c-implement-redblue`，且当前步骤是编码实现阶段。

## 输入 → 输出
| 输入 | 输出 |
|---|---|
| 详细设计、`docs/superpowers/plans/**`、`.r2c/ir.md` | 源码改动、`build_ver{NN}/` 构建与自测记录 |

## 占位期行为
按调用方任务书内联执行子步骤；产物首行写 `> 占位：r2c-implement-redblue 未实现（<date>）`，提交时 `--note placeholder:r2c-implement-redblue`。

## 实现归属
- 未建票；实现后删除顶部占位横幅与本行。
