# r2c

声明式工作流运行器：一份 `r2c.workflow/v1` 清单驱动阶段推进，每个步骤交给已安装的 agent 执行，运行记录留在项目内。

## Language

**引擎 (Engine)**:
执行 `r2c` 命令的那个程序：发现清单、推进步骤、校验提交、维护运行记录。它与载荷、适配器同版本锁定。
_Avoid_: 运行时、runtime、CLI 工具、npm 包

**运行命令 (Runner command)**:
写进 agent 配置的那条命令：`node <引擎入口>`。`project` 作用域写项目相对路径，项目改名、移动后 hook 仍可用；`user` 作用域写带引号的绝对路径（agent 的 cwd 与项目无关）。`--runner-cmd` 是唯一的手工覆盖。
_Avoid_: npx 命令、包名命令、引擎别名

**载荷 (Payload)**:
一次发布携带的工作流内容：清单、任务书、技能、命令、hook 中间层与适配器声明。
_Avoid_: 插件、plugin、内容包

**布局 (Layout)**:
载荷里进入项目的三棵目录：`workflows/`、`tasks/`、`skills/`。安装逐文件复制到项目根并记入回执，卸载按回执回退。
_Avoid_: 内容包、模板、scaffold

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
