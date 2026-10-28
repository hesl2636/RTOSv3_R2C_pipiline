---
name: all-build-single-package
description: 构建单个指定包并返回构件与失败日志。占位：本期未实现，仅声明契约。
---

# all-build-single-package

> **占位（placeholder）** 本技能本期未实现：正文只声明契约，不含可执行步骤；执行细节以调用它的任务书为准，禁止按本技能臆测流程。

## 用途
构建单个指定包，返回构件路径与失败日志。工具不可用时如实报告，禁止伪造构件。

## 何时调用
- 清单 `skills:` 白名单包含 `all-build-single-package`，且当前步骤需要单包构建。

## 输入 → 输出
| 输入 | 输出 |
|---|---|
| 包名、构建目标 | 构件路径或失败日志 |

## 占位期行为
不得伪造执行结果；工具不可用时如实报「all-build-single-package 不可用」，交由 gate/expect 判定（通常是 exit 3 → paused）。

## 实现归属
- 未建票；实现后删除顶部占位横幅与本行。
