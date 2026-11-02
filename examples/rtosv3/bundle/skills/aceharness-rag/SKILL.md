---
name: aceharness-rag
description: 在 AceHarness RAG 索引中检索规范与历史案例。占位：本期未实现，仅声明契约。
placeholder: true
---

# aceharness-rag

> **占位（placeholder）** 本技能本期未实现：正文只声明契约，不含可执行步骤；执行细节以调用它的任务书为准，禁止按本技能臆测流程。

## 用途
在 AceHarness RAG 索引中检索规范条目与历史案例，返回引用与摘要供设计取证。只读检索，不修改索引。

## 何时调用
- 清单 `skills:` 白名单包含 `aceharness-rag`，且当前步骤需要规范或案例依据。

## 输入 → 输出
| 输入 | 输出 |
|---|---|
| 检索问题 | 规范与案例引用清单 |

## 占位期行为
改用 agent 内置检索（读文件 / glob / 正则）完成同等取证，并在产物中标注信息来源；`--note placeholder:aceharness-rag`。

## 实现归属
- 未建票；实现后删除顶部占位横幅与本行。
