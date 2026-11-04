# 工作流构建台 UI 验收

将 bundle 检查器整理为带流程导航的工作空间：桌面侧栏与移动端横向导航保持七个步骤的顺序，上传区支持选择或拖放单个 zip，校验、编译、投影和构建区域提供等待提示。卡片、按钮、键盘焦点及深浅色主题使用统一的样式。

界面交互集中在 `web/workspace-ui.js`；`web/app.js` 继续负责校验、编译、投影和构建。服务端接口及发布规则保持原有契约。

## 截图

截图采集于 2026-11-04。优化前的页面来自本次分支基点 `4caf1e8`，与优化后的桌面页面均使用 1440 × 1080 视口。

| 场景 | 截图 |
| --- | --- |
| 优化前 | [before.png](before.png) |
| 优化后：桌面首页 | [desktop.png](desktop.png) |
| 手机首页：390 × 900 | [mobile.png](mobile.png) |
| 深色主题 | [dark.png](dark.png) |
| 示例 bundle 的编译产物及阶段 | [compiled.png](compiled.png) |
| 构建完成后按 agent 安装：PowerShell | [install.png](install.png) |
| 手机上的 agent 安装命令 | [install-mobile.png](install-mobile.png) |

## 验证

环境：Windows、Node.js 24.22.1、Playwright 1.56.1、Microsoft Edge 156.0.4314.58（无头模式）。Playwright 仅用于本地验收，未增加项目依赖。

```powershell
npm ci
npm test
node scripts/build-bundle.mjs examples/rtosv3/bundle --check
node scripts/release.mjs --check
```

- UI 与按 agent 安装组合后的完整测试：815 项通过，0 项失败。
- 示例 bundle 字节可复现检查通过。
- Release 契约检查通过。
- 原工作流界面验收：38 项检查通过；本次按 agent 安装验收另有 40 项检查通过，均未发现运行错误或控制台错误。

浏览器检查覆盖以下行为：

- 首次打开时，编译按钮禁用，等待状态可见，概览导航随实际结果显示。
- 空页面及全部详情展开后的页面，在 320、390、760、768、1024、1440px 六种宽度下均无页面横向溢出；长路径及 SHA-256 摘要可换行，表格和安装命令保留内部滚动。
- 桌面、手机及深色主题截图经过视觉检查。
- Tab 首先到达「跳转到主要内容」，Enter 可聚焦主内容；原生文件选择仍可通过键盘聚焦。
- 拖放 zip 后显示文件名、大小并启用编译；非 zip 或多个文件被拒绝，原选择保留。
- 示例 `bundle-rtosv3-drvport-v1.0.0.zip` 校验得到 0 个错误、2 个警告；下载的编译产物包含 4 个阶段和 35 个技能。
- 校验成功后等待状态收起，概览、投影选项和编译产物可用；点击导航及滚动到底部时，当前位置正确高亮。
- 默认选项构建成功，生成可下载资产和安装命令。
- 与按 agent 安装组合验证：构建结果包含 `install` 资产，页面分别展示五个 agent 的固定 Release 命令及一条 runner 命令，并可切换 PowerShell 与 Bash。
- 无效 zip 显示诊断并恢复编译产物等待状态；超过 8 MiB 的文件显示大小限制说明。

浏览器验收未执行真实 Release 发布；发布流程由现有测试中的本地 fixture 验证。

## 一键安装组合验证

`test/release-launcher.test.js` 包含 31 项启动器回归，覆盖投影选择、GitHub 凭据优先级、Git 凭据回退、镜像凭据隔离、私有资产 API 下载、仓库固定、Node 版本要求、超时、校验失败及临时目录清理。

其中的真实子进程测试通过 stdin 执行 `node -`，从完整本地 Release 镜像安装到六个独立项目：默认 runner 生成运行器与回执，五条生成的 agent 命令分别安装 Claude Code、Codex、dsh、OMP 和 OpenCode。每个 agent 项目均只包含所选宿主的文件和回执，且不安装 runner。测试还确认安装临时目录已清空。

自定义私有仓库使用本地 GitHub fixture 验证指定版本与最新版本的安装；已有构建发布时，仓库不匹配会在远程请求前被拒绝，同仓库发布保持构建字节不变。

## 按 agent 安装命令验收

本次浏览器验收包含 40 项检查，截图使用真实的默认构建结果：

- 五个 agent 各有一条带 `--target` 的安装命令；runner 以独立条目明确标注 `--projection runner`。
- Windows 默认选择 PowerShell，六条命令均使用 `curl.exe`；切换到 macOS/Linux 后均使用 `curl`。
- 两种环境下逐条点击六个复制按钮，剪贴板内容与当前显示的完整命令一致，仓库、Release tag 和目标均正确。
- 320、390、760、768、1024、1440px 下页面无横向溢出，深色主题正常；长命令可在自身区域内横向滚动。
- 发布成功界面使用浏览器本地 fixture 检查同样的六条命令、环境切换和复制行为，没有向 GitHub 发起发布操作。

`runner` 与 `agent-native` 的安装语义保持一致：前者安装全部支持宿主的运行器接入，后者按目标安装可单独调用的技能、阶段技能和角色。
