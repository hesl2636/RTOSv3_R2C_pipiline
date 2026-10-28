---
name: huawei-c-coding-standard
description: 按华为 C 编码规范检查代码并给出整改项。占位：本期未实现，仅声明契约。
---

# huawei-c-coding-standard

> **占位（placeholder）** 本技能本期未实现：正文只声明契约，不含可执行步骤；执行细节以调用它的任务书为准，禁止按本技能臆测流程。

## 用途
按华为 C 编码规范检查目标代码，给出违规位置与整改项。工具不可用时如实报告，禁止伪造合规结论。

## 何时调用
- 清单 `skills:` 白名单包含 `huawei-c-coding-standard`，且当前步骤需要 C 规范检查。

## 输入 → 输出
| 输入 | 输出 |
|---|---|
| C 源码范围 | 规范检查报告与整改项 |

## 占位期行为
不得伪造执行结果；工具不可用时如实报「huawei-c-coding-standard 不可用」，交由 gate/expect 判定（通常是 exit 3 → paused）。

## 实现归属
- 未建票；实现后删除顶部占位横幅与本行。
