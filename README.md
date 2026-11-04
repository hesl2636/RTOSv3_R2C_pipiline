# hm2b

hm2b 把一份声明式工作流 bundle 编译成编译产物（`workflow.compiled.json`），再投影并安装成宿主可直接使用的文件集：

- `runner`：带状态、门禁和提交回执的本地运行器
- `agent-native`：OMP、Claude Code、Codex、dsh、OpenCode 的原生技能与子 agent 定义

本文只保留从一台干净电脑开始安装和使用的完整流程。

---

## 1. 准备

### 1.1 运行环境

| 项目 | 要求 |
| --- | --- |
| Node.js | `>=22.19.0 <23` 或 `>=24.0.0` |
| GitHub CLI | 安装并使用 `gh auth login` 登录 |
| 目标项目 | 一个空目录，或已有项目根目录 |
| 宿主 | 按需安装 OMP / Claude Code / Codex / dsh / OpenCode |

检查：

```powershell
node --version
gh --version
gh auth status
```

Windows PowerShell 5.1 不支持 `&&`。下文命令可以逐行执行；需要一行时用 `;` 连接。

### 1.2 变量约定

后续命令使用以下变量。按实际版本修改：

```powershell
$REPO    = "hesl2636/hm2B_drvport_pipiline"
$BUNDLE  = "rtosv3-drvport"
$VERSION = "1.0.1"
$TAG     = "bundle-$BUNDLE-v$VERSION"
```

`$TAG` 必须和 Release 的 tag 完全一致。

---

## 2. 发布端：构建并发布 bundle

> 只有在还没有可安装的 Release 时才需要这一节。已有 Release 时直接跳到第 3 节。

### 2.1 获取框架源码

```powershell
git clone https://github.com/hesl2636/hm2B_drvport_pipiline.git
cd hm2b_drvport_pipiline
```

然后在源码目录执行 `npm install`，安装唯一依赖 `yaml`。

### 2.2 启动本地检查器

```powershell
node web/serve.mjs
```

打开：

```text
http://127.0.0.1:8787/
```

Web 服务端会自动读取本机 `gh auth token`，不需要手工设置 `GH_TOKEN`。

### 2.3 上传并构建

1. **01 上传 bundle** 选择：

```text
examples/rtosv3/dist/bundle-rtosv3-drvport-v1.0.0.zip
```

2. **版本** 填：

```text
1.0.1
```

3. 点击 **校验并编译**
4. 确认 **03 校验结果** 没有 error
5. 确认 **04 编译产物** 已生成 `workflow.compiled.json`
6. 在 **06 构建产物** 点击 **构建并发布**

发布会创建：

```text
bundle-rtosv3-drvport-v1.0.1
```

如果该 tag 已存在，发布会失败。不要覆盖已发布 Release，改用下一个 patch：

```text
1.0.2
1.0.3
```

然后在 **01 上传** 重新填版本、重新上传、重新构建发布。

发布成功后，**06 构建产物** 会给出每个目标的一键安装命令。

---

## 3. 使用端：安装

以下命令都在**目标项目根目录**执行。

### 3.1 agent-native + OMP

```powershell
cd C:\work\my-project

$REPO    = "hesl2636/hm2B_drvport_pipiline"
$BUNDLE  = "rtosv3-drvport"
$VERSION = "1.0.1"
$TAG     = "bundle-$BUNDLE-v$VERSION"

gh release download $TAG --repo $REPO --dir ".hm2b/release/$TAG" --clobber

node ".hm2b/release/$TAG/install.mjs" --bundle $BUNDLE --version $VERSION --projection agent-native --target omp --release-base .hm2b/release --project .
```

这条命令做两件事：

1. 把整个 Release 下载到 `.hm2b/release/<tag>/`
2. 从本地目录离线安装，安装阶段不再访问网络，也不需要 token

### 3.2 runner

```powershell
node ".hm2b/release/$TAG/install.mjs" --bundle $BUNDLE --version $VERSION --projection runner --release-base .hm2b/release --project .

node .hm2b/bin/hm2b.js status
```

runner 会额外安装：

```text
.hm2b/engine/
.hm2b/bin/hm2b.js
.hm2b/projection/roles.json
```

### 3.3 其他 agent-native 目标

把 `--target omp` 换成：

```text
claude-code
codex
dsh
opencode
```

不传 `--target` 时安装该投影的全部目标。

---

## 4. 验证

### 4.1 agent-native

```powershell
Get-ChildItem .agents\skills
```

应看到裸名称，例如：

```text
r2c-design
workflow
stage-analysis-design
```

检查 frontmatter：

```powershell
Select-String -Path .agents\skills\r2c-design\SKILL.md -Pattern '^name:'
Select-String -Path .agents\skills\workflow\SKILL.md -Pattern '^name:'
```

期望：

```text
name: r2c-design
name: workflow
```

检查角色文件：

```powershell
Get-ChildItem .omp\agents
```

期望：

```text
bys-architect.md
bys-designer.md
bys-impl-lead.md
bys-release-lead.md
```

检查安装回执：

```powershell
Get-Content .hm2b\install\receipts\agent-native\rtosv3-drvport.json
```

期望包含：

```json
"bundle": { "id": "rtosv3-drvport", "version": "1.0.1" }
```

### 4.2 runner

```powershell
node .hm2b/bin/hm2b.js status
node .hm2b/bin/hm2b.js validate
```

### 4.3 OMP

```powershell
omp
```

在 OMP 中输入：

```text
/skill:workflow
```

应看到：

```text
skill:r2c-design
skill:workflow
skill:stage-analysis-design
```

如果仍看到旧的 `skill:rtosv3-drvport-*`：

```powershell
Remove-Item .agents,.hm2b,.omp -Recurse -Force
```

然后重新执行第 3.1 节安装，并重启 OMP。

---

## 5. 安装后布局

### agent-native

```text
.agents/
  skills/
    workflow/SKILL.md
    stage-<stage-id>/SKILL.md
    <skill-id>/SKILL.md
  agent-native/
    <bundle-id>/
      roles.json
      knowledge-base/
      checklists/
      hooks/hooks.json
      mcp.json
.omp/agents/<role-id>.md
```

### runner

```text
.hm2b/
  bin/hm2b.js
  engine/
  projection/roles.json
knowledge-base/
checklists/
hooks/hooks.json
mcp.json
```

agent-native 的共享资产写入 `.agents/agent-native/<bundle-id>/`；安装器会校验 `hm2b.bundle/v2`、`hm2b.compiled-workflow/v2` 与 `SHA256SUMS.txt`。资产路径最多 **4 段**，只接受清单声明的 `knowledge-base/`、`checklists/`、`hooks/hooks.json` 和 `mcp.json`；未声明文件会被拒绝。

多个 bundle 如果使用相同的裸 skill/role 名称，会返回 `INSTALL_CONFLICTS`。一个项目只安装一组工作流名称，或先卸载旧 bundle。

---

## 6. 升级

升级就是安装新版本 Release：

```powershell
$VERSION = "1.0.2"
$TAG = "bundle-$BUNDLE-v$VERSION"

gh release download $TAG --repo $REPO --dir ".hm2b/release/$TAG" --clobber

node ".hm2b/release/$TAG/install.mjs" --bundle $BUNDLE --version $VERSION --projection agent-native --target omp --release-base .hm2b/release --project .
```

已发布的 Release 不会被改写。需要变更内容时发布新的 patch 版本。

---

## 7. 常见问题

**`gh: command not found`**

安装 GitHub CLI，并执行：

```powershell
gh auth login
```

**`ENGINE_DOWNLOAD_FAILED` / 安装器访问 GitHub 超时**

不要使用旧的单文件引导方式。先完整下载 Release：

```powershell
gh release download $TAG --repo $REPO --dir ".hm2b/release/$TAG" --clobber
```

再用 `--release-base .hm2b/release` 从本地安装。

**发布按钮不可用**

确认：

```powershell
gh auth status
```

并重启 Web。只有服务端启动时成功读取 token，发布才可用。

**OMP 仍显示旧前缀**

删除旧安装后重装：

```powershell
Remove-Item .agents,.hm2b,.omp -Recurse -Force
```

并重启 OMP。
