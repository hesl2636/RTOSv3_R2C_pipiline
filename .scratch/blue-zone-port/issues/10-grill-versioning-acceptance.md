# 决策：版本策略与机器可验证的验收判据

Type: grilling
Status: open
Labels: wayfinder:grilling
Blocked by: 05, 06, 07
Map: ../map.md

## Question

内核与五份适配层的版本策略是什么（单一版本号还是各自独立、兼容矩阵如何表达、升级时如何避免内核与适配层错配），以及「装得上 + 命令可发现 + 首步能提交」各用什么命令、退出码与输出判据机器可验证（能否进 CI、在哪个 agent 环境里跑）？
