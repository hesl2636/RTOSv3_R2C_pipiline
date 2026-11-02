---
name: all-cleancode
description: 调用 CleanCode 扫描并返回问题清单。占位：本期未实现，仅声明契约。
placeholder: true
---

# all-cleancode

> **占位（placeholder）** 本技能本期未实现：正文只声明契约，不含可执行步骤；执行细节以调用它的任务书为准，禁止按本技能臆测流程。

## 用途
调用 CleanCode 扫描目标范围并返回问题清单。工具不可用时如实报告，禁止伪造扫描结果。

## 何时调用
- 清单 `skills:` 白名单包含 `all-cleancode`，且当前步骤需要 CleanCode 扫描。

## 输入 → 输出
| 输入 | 输出 |
|---|---|
| 扫描范围 | 扫描报告与问题清单 |

## 占位期行为
不得伪造执行结果；工具不可用时如实报「all-cleancode 不可用」，交由 gate/expect 判定（通常是 exit 3 → paused）。

## 实现归属
- 未建票；实现后删除顶部占位横幅与本行。
