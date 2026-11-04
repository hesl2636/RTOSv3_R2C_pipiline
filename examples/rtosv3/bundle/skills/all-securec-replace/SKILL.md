---
name: all-securec-replace
description: 批量替换敏感信息并产出替换清单。占位：本期未实现，仅声明契约。
placeholder: true
---

# all-securec-replace

> **占位（placeholder）** 本技能本期未实现：正文只声明契约，不含可执行步骤；执行细节以调用它的任务书为准，禁止按本技能臆测流程。

## 用途
按规则批量替换敏感信息，产出替换清单与校验记录。工具不可用时如实报告，禁止伪造替换结果。

## 何时调用
- 清单 `skills:` 白名单包含 `all-securec-replace`，且当前步骤需要敏感信息替换。

## 输入 → 输出
| 输入 | 输出 |
|---|---|
| 待替换文件、替换规则 | 替换清单与校验记录 |

## 占位期行为
不得伪造执行结果；工具不可用时如实报「all-securec-replace 不可用」，交由 gate/expect 判定（通常是 exit 3 → paused）。

## 实现归属
- 未建票；实现后删除顶部占位横幅与本行。
