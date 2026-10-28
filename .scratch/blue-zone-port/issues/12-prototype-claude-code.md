# 原型：claude code 适配骨架一次性验证

Type: prototype
Status: open
Labels: wayfinder:prototype
Blocked by: 05, 06, 07
Map: ../map.md

## Question

按内核 schema 与适配层契约，用 claude code 做一次一次性骨架原型（临时目录或临时分支，不进主干、不发版），能否证明三件事成立：安装后命令被该 agent 发现、首步能 `submit`、状态落项目内 `.r2c/` 且可见，以及这个过程中适配层契约暴露了哪些原先没料到的约束？
