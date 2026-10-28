# 决策：推进机制分档与降级语义

Type: grilling
Status: open
Labels: wayfinder:grilling
Blocked by: 01, 02, 03, 05
Map: ../map.md

## Question

五个 agent 按 hooks、子代理、任务机制的能力如何分档，每档里「下一步该做什么」由谁触发（钩子自动推进 vs 显式 runner 子命令 vs agent 原生任务机制），钩子缺失的 agent 上「首步能提交」如何判定、用户看到什么提示，以及同一阶段在不同档位上的行为差异允许有多大？
