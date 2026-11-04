# hm2b

hm2b 把一份声明式工作流 bundle（zip，`hm2b.bundle/v2`）编译成 `workflow.compiled.json`（`hm2b.compiled-workflow/v2`），再投影并发布成宿主可直接安装的文件集：`runner`（带状态、门禁、提交回执的本地运行器）与 `agent-native`（OMP、Claude Code、Codex、dsh、OpenCode 的原生技能与子 agent）。

---

## 1. 安装、构建与发布

### 1.1 环境

| 项目 | 要求 |
| --- | --- |
| Node.js | `>=22.19.0 <23` 或 `>=24.0.0` |
| GitHub CLI | 已安装并 `gh auth login`，token 具备 `repo` 权限 |
| 目标项目 | 一个空目录或已有项目根目录 |

```powershell
node --version
gh auth status
git clone https://github.com/hesl2636/hm2B_drvport_pipiline.git
cd hm2b_drvport_pipiline
```

在源码目录安装唯一依赖 `yaml`：执行 `npm ci`。

下文用到的变量：

```powershell
$REPO    = "hesl2636/hm2B_drvport_pipiline"
$BUNDLE  = "rtosv3-drvport"
$VERSION = "1.0.2"      # 每次发布换新号；已发布的版本不能复用
$TAG     = "bundle-$BUNDLE-v$VERSION"
```

### 1.2 构建并发布

```powershell
node web/serve.mjs
```

打开 `http://127.0.0.1:8787/`。服务端启动时自行读取本机 `gh auth token`，无需设置 `GH_TOKEN`；右上角显示"发布已启用"才可发布。

1. **01 上传 bundle**：选择 zip（示例：`examples/rtosv3/dist/bundle-rtosv3-drvport-v1.0.0.zip`），**版本**填 `$VERSION`，点 **校验并编译**。
2. **03 校验结果**：error 必须为 0。
3. **04 编译产物**：确认已生成 `workflow.compiled.json`。
4. **06 构建产物**：点 **构建并发布**（或先 **构建**，确认"可发布"后到 **07 发布 Release** 点 **发布**）。
5. 发布流程为 `预检 → 草稿 → 上传资产 → 摘要校验 → 正式发布 → 回读`，成功后生成 tag `$TAG`。

规则：

- 已发布的 tag 与资产永不改写；发布失败后要换新 patch 版本，不能覆盖。
- 自定义投影选项（**05**）产生的构建是 `publishable=false`，只能本地使用，不能发布。
- 发布成功后，**06 构建产物** 会给出每个目标可直接复制的安装命令。

### 1.3 一条命令本地安装

在**目标项目根目录**执行。命令先用 `gh` 把整个 Release 下载到 `.hm2b/release/$TAG`，再从本地目录离线安装；安装阶段不再访问网络，也不需要 token。在目标项目的 shell 中重新定义变量：

```powershell
$REPO    = "hesl2636/hm2B_drvport_pipiline"
$BUNDLE  = "rtosv3-drvport"
$VERSION = "1.0.2"
$TAG     = "bundle-$BUNDLE-v$VERSION"
```

runner：

```powershell
gh release download $TAG --repo $REPO --dir ".hm2b/release/$TAG" --clobber; node ".hm2b/release/$TAG/install.mjs" --bundle $BUNDLE --version $VERSION --projection runner --release-base .hm2b/release --project .
```

agent-native（`--target` 取 `omp`、`claude-code`、`codex`、`dsh`、`opencode`；省略则安装全部目标）：

```powershell
gh release download $TAG --repo $REPO --dir ".hm2b/release/$TAG" --clobber; node ".hm2b/release/$TAG/install.mjs" --bundle $BUNDLE --version $VERSION --projection agent-native --target omp --release-base .hm2b/release --project .
```

agent-native 的共享资产（`knowledge-base/`、`checklists/`、`hooks/hooks.json`、`mcp.json`）写在 `.agents/agent-native/<bundle-id>/`，技能与角色写到各宿主自己的目录。

安装后自检（仅 runner）：

```powershell
node .hm2b/bin/hm2b.js validate
node .hm2b/bin/hm2b.js status
```

---

## 2. bundle zip 的格式要求

zip 根必须直接是 `bundle.json`，不能再套一层目录。`bundle.json` 的声明与归档内容必须**双向相等**：声明的文件缺失报错，未声明的文件（含多余的 stage/task/role/skill 目录与资产文件）同样报错。

### 2.1 目录结构

```text
bundle.json
stages/<id>.json
roles/<id>.md
tasks/<id>.md
skills/<id>/SKILL.md
constitution/CONSTITUTION.md        # 仅在 bundle.json 声明时
knowledge-base/<group>[/<subgroup>]/<file>.md
checklists/<id>.md
hooks/hooks.json                    # 仅在声明时
mcp.json                            # 仅在声明时
README.md                           # 可选，不参与编译
```

`<id>` 一律为 `^[a-z0-9]+(?:-[a-z0-9]+)*$`，最长 64；bundle id 最长 40 且不得为 `hm2b`。`skills/<id>/` 下只允许 `SKILL.md`。

### 2.2 容器限制

| 项目 | 上限 |
| --- | --- |
| zip 大小 | 8 MiB |
| 归档条目（含目录） | 512 |
| 解压后总量 | 32 MiB |
| 单个条目 | 4 MiB |
| 路径 | 100 UTF-8 字节、4 段 |
| `tasks/<id>.md` | 128 KiB |
| `constitution/CONSTITUTION.md` | 64 KiB |

### 2.3 `bundle.json`

必填：`schema`、`id`、`name`、`version`、`description`、`stages`、`tasks`。
可选：`roles`、`skills`、`knowledgeBase`、`checklists`、`hooks`、`mcp`、`constitution`、`requires`。

```json
{
  "schema": "hm2b.bundle/v2",
  "id": "rtosv3-drvport",
  "name": "RTOSv3 R2C 移植流水线",
  "version": "1.0.0",
  "description": "四阶段移植流水线",
  "stages": ["analysis-design"],
  "tasks": ["analysis-design-orchestration"],
  "constitution": { "path": "constitution/CONSTITUTION.md", "placeholder": true }
}
```

- `schema` 只能是 `hm2b.bundle/v2`；`version` 是严格 semver，不带 build metadata。
- `name` 1–120 字符，`description` 1–2000 字符；数组项不得重复。
- `roles` 不得用 `main`/`sub`；`skills` 不得用 `synced`/`anthropic-skills`。
- `knowledgeBase` 是 `knowledge-base/**.md` 路径列表；`checklists` 的 `<id>` 对应 `checklists/<id>.md`。
- `hooks` 只能声明 `{"path":"hooks/hooks.json"}`，`mcp` 只能声明 `{"path":"mcp.json"}`。
- `constitution.path` 只能是 `constitution/CONSTITUTION.md`；`placeholder:true` 时允许空文件。
- `requires` 只接受 `engine`（semver range）与 `projections`（`runner` / `agent-native`），至少一个键。
- 键顺序固定为 `schema`、`id`、`name`、`version`、`description`、`stages`、`roles`、`tasks`、`skills`、`knowledgeBase`、`checklists`、`hooks`、`mcp`、`constitution`、`requires`，未知键报错。

### 2.4 `stages/<id>.json`

```json
{
  "id": "analysis-design",
  "name": "分析设计",
  "description": "可选",
  "steps": [
    {
      "id": "analysis-design-orchestration",
      "name": "需求分析与设计编排",
      "role": "bys-architect",
      "task": "analysis-design-orchestration",
      "skills": ["req-analysis"],
      "outputs": [".r2c/ir.md"],
      "gates": [{ "command": "git diff --quiet", "timeout": 600 }]
    }
  ]
}
```

- stage 键顺序：`id`、`name`、`description`、`steps`；step 键顺序：`id`、`name`、`role`、`task`、`skills`、`outputs`、`gates`。
- step 必填 `id`、`name`、`task`；`id` 在整份 bundle 内唯一。
- `stages` 数组顺序与 step 数组顺序即执行顺序，不做排序。
- `role`、`task`、`skills` 必须是已声明的裸 id，不写文件路径。
- `outputs` 是相对 POSIX glob，不得以 `/` 或盘符开头、不得含 `..`、不得指向技能载荷。
- `gates[].command` 非空且 ≤2000 字符，`timeout` 为 1–86400 秒。

### 2.5 `tasks/<id>.md`

正文必须按顺序包含且只包含四个二级标题：

```text
## Agent 角色设定
## 任务
## 约束条件
## 提交
```

`## 提交` 内必须恰好有一个代码块，且块内只有一行 `{{submit}}`：

````text
## 提交

```
{{submit}}
```
````

- 任务书不允许 `placeholder: true`；正文不得为空。
- frontmatter 可省略；若写，只允许 `id`、`title`、`description`，且 `id` 必须等于文件名。

### 2.6 `skills/<id>/SKILL.md` 与 `roles/<id>.md`

```markdown
---
name: req-analysis
description: 需求分析
---

正文……
```

- skill 必填 `name`、`description`，`name` 必须等于目录名；不得为空；正文不得为空。
- `placeholder: true` 的 skill 必须在正文开头出现横幅 `> **占位（placeholder）**`。
- role 必填 `id`、`description`，`id` 必须等于文件名；可选 `title`、`mode`（`subagent|primary|any`）、`model`（`fast|standard|strong`）、`effort`（`low|medium|high|xhigh|max`）、`tools`、`tools_deny`、`skills`、`placeholder`。
- role 的 `tools` 只接受 `read|write|edit|glob|grep|bash|task|web`；`skills` 必须是已声明技能；这两个数组按码点升序排列。
- 非占位 role 的正文不得为空。

### 2.7 资产文件

- `knowledge-base/**`、`checklists/*.md` 只有被 `knowledgeBase` / `checklists` 声明才会被接收。
- `hooks/hooks.json`、`mcp.json` 必须被声明；`mcp.json` 顶层必须含对象 `mcpServers`。
- 这两个 JSON 必须规范：内容等于 `JSON.stringify(value, null, 2)` 加一个换行，键不重复，无注释、无尾逗号。

### 2.8 文本编码

所有文本文件为 UTF-8，不带 BOM，只用 LF，不得包含 CR，非空文件必须以一个换行结束。
`bundle.json`、stage 文件、`hooks.json`、`mcp.json` 必须是规范 JSON（两空格缩进、末尾单个 LF）。
Markdown frontmatter 只支持受限 YAML：`key: 标量` 或 `key:` 加 `- item` 列表，不接受引号、flow 集合、注释、锚点、标签、多行标量和 `null`。

### 2.9 本地校验

```powershell
node bin/hm2b-assembler.js bundle validate examples\rtosv3\dist\bundle-rtosv3-drvport-v1.0.0.zip
node scripts/build-bundle.mjs examples/rtosv3/bundle --out examples/rtosv3/dist/bundle-rtosv3-drvport-v1.0.0.zip
```

参考实现：`examples/rtosv3/bundle/`（49 个文件，校验基线为 0 error、2 warning）。`scripts/build-bundle.mjs` 生成的 zip 是确定性产物（store 压缩、固定时间戳），可重复构建出相同字节。
