---
name: r2c-verify-rb
description: 编排 R2C 验证检视阶段，聚合构建、扫描与红蓝结论。占位：本期未实现，仅声明契约。
---

# r2c-verify-rb

> **占位（placeholder）** 本技能本期未实现：正文只声明契约，不含可执行步骤；执行细节以调用它的任务书为准，禁止按本技能臆测流程。

## 用途
验证检视阶段主控编排：按拓扑调用 r2c-build-redblue、v3-personal-pipeline、all-cleancode、r2c-review 与 semantic-equiv，汇总 final-verification 结论并收口 VERIFY 边界门禁。只编排，不内联原子技能。

## 何时调用
- 清单 `skills:` 白名单包含 `r2c-verify-rb`，且当前步骤是验证检视阶段。

## 输入 → 输出
| 输入 | 输出 |
|---|---|
| 实施产物、`design_doc_ver{NN}/` 验收条件 | `.r2c/artifacts/final-verification.log`、检视报告与遗留问题清单 |

## 占位期行为
按调用方任务书内联执行子步骤；产物首行写 `> 占位：r2c-verify-rb 未实现（<date>）`，提交时 `--note placeholder:r2c-verify-rb`。

## 实现归属
- 未建票；实现后删除顶部占位横幅与本行。
