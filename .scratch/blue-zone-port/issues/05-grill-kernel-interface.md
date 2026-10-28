# 决策：内核清单 schema 与 runner 子命令集

Type: grilling
Status: open
Labels: wayfinder:grilling
Blocked by: 01, 02, 03, 04
Map: ../map.md

## Question

内核的声明式清单取什么 schema（stage/step/command 类型、agent、skill、taskFile、timeout、gate 与 expectations 的字段与校验规则），runner 暴露哪些子命令（next/submit/status/resume/cancel/token-usage 等）及各自退出码与输出契约，现有引擎的语义（门禁校验、提交拦截、状态机、token 计量）哪些必须保留、哪些明确丢弃？
