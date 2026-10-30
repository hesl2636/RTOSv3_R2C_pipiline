# r2c

声明式工作流运行器：一份 `r2c.workflow/v1` 清单驱动阶段推进，每个步骤交给已安装的 agent 执行，运行记录留在项目内。

## Language

**引擎 (Engine)**:
执行 `r2c` 命令的那个程序：发现清单、推进步骤、校验提交、维护运行记录。它与载荷、适配器同版本锁定。
_Avoid_: 运行时、runtime、CLI 工具、npm 包

**载荷 (Payload)**:
一次发布携带的工作流内容：清单、任务书、技能、命令、hook 中间层与适配器声明。
_Avoid_: 插件、plugin、内容包

**适配器 (Adapter)**:
把一个具体 agent 接上引擎与载荷的声明与资产，覆盖 `claude-code`、`codex`、`dsh`、`omp`、`opencode` 五者之一。
_Avoid_: 集成、integration、驱动

**安装 (Install)**:
同一次操作里完成的三件事：引擎落到本机、按适配器声明写好 agent 配置、载荷布局进入项目。三者要么一起成立，要么都不成立。
_Avoid_: 部署、deploy、setup

**安装回执 (Receipt)**:
一次安装的账本：写了哪些文件、合并了哪些配置项、从哪里可以回退。卸载与自检只认它。
_Avoid_: manifest、清单、日志

**作用域 (Scope)**:
一次安装的可见范围：`project` 跟随项目目录，`user` 跟随账号。
_Avoid_: 级别、level、模式

**运行态 (State)**:
项目内 `.r2c/` 下随运行增长的记录，卸载默认保留。
_Avoid_: 缓存、cache
