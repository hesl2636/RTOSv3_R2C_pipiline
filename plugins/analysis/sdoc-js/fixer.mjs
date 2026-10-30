// fixer.mjs — 产出优化方案：把确认为 real 的问题，转成可注入项目的知识块
// 对照 Python fixer.py

import { KnowledgeBlock } from './model.mjs';
import { callModel, extractJson } from './codeagent-client.mjs';
import { inferScope } from './scope-rules.mjs';

const FIX_PROMPT = `基于确认的问题，写出项目知识，防止这些低效在后续 AI 编码 session 中复现。输出将写入项目的 \`.ai-knowledge.md\`。

规则：
只使用 FACTS 或证据切片中的值。绝不臆造路径/版本/命令；未知时写 \`<fill: what>\`。
- 每个知识块：简短、祈使句、直接可操作。相关修复分组；
\`solves\` 列出它预防的场景 id。
- 区分执行失败类块（## Skill & MCP Usage / ## Available Tools / ## Prerequisites）和资源消耗异常类块（## Runtimes / ## Commands / ## Build Gotchas / ## Env Vars）。
- attribution_type = "execution_failure"（执行失败类）或 "resource_anomaly"（资源消耗异常类）
- 每个知识块必须输出 scope 字段: "personal"（个人/本机环境差异，如用户目录路径、个人 shell 配置、本机依赖）或 "organization"（组织/项目通用知识，如标准构建命令、git 规范、通用流程）。依据证据切片语义判断。
- 建议表述要通俗易懂：用"请检查..."或"在项目 markdown 中预置..."或"在工作流中编排..."，不要用"项目笔记应记录"这种晦涩表述。

## fix_prompt 字段（如何修复的 prompt 建议）

对于适合「补充 prompt 知识即可避免重复试错」的场景（S1 运行时探测、S2 结构探索、S3 构建命令试错、S5 构建反复失败、S6 lint 循环、S7 测试反复失败、S9 依赖错误、S16 环境变量探测），每个知识块额外输出 fix_prompt 字段：一段可直接追加到 workflow 步骤 prompt 末尾的约束文本。

fix_prompt 生成规则（重要）：
- **核心：给出最终成功的命令**。python/测试等命令，模型通过上下文多次探索后最终会成功——fix_prompt 就是那条最后成功的命令，精炼一行：
\`"- 构建命令：\\\`<最后成功的命令>\\\`（最终成功命令，直接使用，勿再试错）"\`
- 如果当前证据片段中看不到最终结果 → **必须使用 context_requests 调用 getNextFragments(slice_id, count) 查看后续切片**，找到最终成功的命令
- 查看后续片段后仍无成功命令（反复失败、始终无成功） → fix_prompt 写：
\`"- 请在工作流中指定正确的 <构建/测试/环境> 命令"\`（提示用户手动填写）
- fix_prompt 保持精简（1-2 行），只写命令和必要版本，不要长篇描述

不适用 fix_prompt 的场景（S4 git 失败、S8 命令不存在、S10 import 找不到、S11 重复读文件、S13 Edit 前未 Read、S14 工具误用、S15 无验证声称、S18/S19/S20 skill/MCP 报错）——这类场景补 prompt 无法直接修复，fix_prompt 留空字符串。

## 可用工具（只读，多轮获取更多上下文）

如果你认为当前证据片段不足以找到最终成功命令，可在返回 JSON 中带 \`context_requests\` 字段请求更多上下文。系统会执行这些请求并在下一轮对话中返回结果。**最多 3 轮。**

**可用工具：**
1. \`getNextFragments(slice_id, count)\`获取指定切片之后的 N 个片段（用于查看某命令执行之后最终成功/失败）
2. \`getPreviousFragments(slice_id, count)\`获取指定切片之前的 N 个片段
3. \`getFragmentById(slice_id)\`获取指定 ID 的片段完整内容
4. \`getSessionOverview()\`获取 session 概览（所有片段的索引和元数据）

**何时必须请求上下文：**
- 命令试错类场景（S3/S5/S6/S7）：证据片段看不到最终结果 → **必须调用 getNextFragments 查看后续切片**，确认最终成功的命令
- 证据片段不完整、被截断、或无法判断最终结果 → 调用 getFragmentById / getSessionOverview
- **不要臆造成功命令**，必须从证据片段或工具调用结果中确认

**返回格式（第一轮）：**
{{"knowledge_blocks":[...],"claude_md_patch":"...","context_requests":[{{"tool":"getNextFragments","args":{{"slice_id":"xxx-sl0003","count":2}}}}]}}

**返回格式（后续轮次，带上下文结果）：**
系统会在 prompt 中注入 \`[工具调用结果]\`，基于新信息更新 knowledge_blocks（此时不要再含 context_requests，除非仍需更多上下文且未达 3 轮上限）。

Return ONLY JSON, no fence:
{{"knowledge_blocks":[{{"title":"Commands","markdown":"## Commands\\n- Build: ...","solves":["S3"],"attribution_type":"resource_anomaly","scope":"organization","fix_prompt":"- 构建命令：\\\`python -m pytest tests/\\\`（最终成功命令，直接使用，勿再试错）"}}],"claude_md_patch":"one line for CLAUDE.md"}}

Confirmed problems (with evidence locators):
{problems}

FACTS (script-extracted, trustworthy):
{facts}

Evidence slices:
{slices}

{context_results}
`;

const _SECRET_RE = /(password|passwd|secret|token|key|credential|auth|api[-_]?key|private)/i;
const _ENV_PROBE_RE = /^\s*(echo\s+["']?\$\{?(\w+)\}?|printenv\s+(\w+)|export\s+(\w+))/i;
const _VER_RE = /\b\d+\.\d+[\w.\-]*\b/;

export function extractFacts(trace, slices) {
  const facts = { runtimes: {}, env_vars: {}, commands_seen: [], failing_commands: [], paths_seen: [], errors: [] };

  for (const e of trace.bashEvents()) {
    const cmd = (e.command || "").trim();
    if (!cmd) continue;
    if ((cmd.includes("--version") || cmd.includes("which ") || cmd.includes(" -v")) && e.tool_output && !e.is_error) {
      const ver = _VER_RE.exec(e.tool_output || "");
      facts.runtimes[cmd] = (e.tool_output || "").trim().split("\n")[0].slice(0, 80);
    }
    const m = cmd.match(_ENV_PROBE_RE);
    if (m && e.tool_output && !e.is_error) {
      let varName = m[2] || m[3] || m[4] || "";
      let value = (e.tool_output || "").trim().split("\n")[0].slice(0, 120);
      if (varName && _SECRET_RE.test(varName)) value = "<redacted>";
      if (varName) facts.env_vars[varName] = value;
    }
    facts.commands_seen.push(cmd.slice(0, 80));
    if (e.is_error) {
      facts.failing_commands.push(cmd.slice(0, 80));
      if (e.tool_output) facts.errors.push((e.tool_output || "").trim().split("\n")[0].slice(0, 120));
    }
  }
  for (const e of trace.tool_calls) {
    for (const p of (e.file_paths || [])) {
      if (!facts.paths_seen.includes(p)) facts.paths_seen.push(p);
    }
  }
  // 去重
  facts.commands_seen = [...new Set(facts.commands_seen)].slice(0, 20);
  facts.failing_commands = [...new Set(facts.failing_commands)].slice(0, 15);
  facts.paths_seen = facts.paths_seen.slice(0, 25);
  facts.errors = [...new Set(facts.errors)].slice(0, 15);
  return facts;
}

function _renderSlices(slices, budget = 3000) {
  const out = [];
  let used = 0;
  for (const s of slices) {
    const b = `### ${s.slice_id}\n${s.renderCompact()}`;
    if (used + b.length > budget) break;
    out.push(b);
    used += b.length;
  }
  return out.join("\n\n") || "(none)";
}

export class MockFixer {
  constructor() { this.name = "mock"; }

  fix(verdicts, wiki, trace, facts) {
    const blocks = [];
    const solved = verdicts.filter(v => v.is_real).map(v => v.scenario);

    // 通用辅助：从命令序列（后文）提取最后一次执行成功的匹配命令 = 最终成功命令。
    // 注意：同一命令可能先失败后成功（试错后成功），不能只看「不在 failing 列表」，
    // 必须按执行事件逆序找「该次执行成功」的命令。
    const lastSuccessBy = (kws, exclude = null) => {
      const events = (trace && trace.bashEvents ? trace.bashEvents() : []) || [];
      for (let i = events.length - 1; i >= 0; i--) {
        const c = (events[i].command || '').trim();
        if (!c || events[i].is_error) continue;
        if (kws.some(k => c.includes(k)) && (!exclude || !exclude(c))) return c;
      }
      return null;
    };

    if (solved.some(s => s === "S1" || s === "S3")) {
      const rt = Object.entries(facts.runtimes).slice(0, 8).map(([k, v]) => `- ${k}: ${v}`).join("\n");
      const failing = new Set(facts.failing_commands);
      // 探测类命令（--version / which / env 等）不视为「运行命令」，跳过
      const PROBE_RE = /(--version|-v\b|which |env |printenv|echo \$|--help|node -e)/;
      // 按类别提取「最后成功命令」（命令序列中最后一个非失败、非探测且匹配类别关键字）
      const lastSuccess = (kws) => {
        for (let i = facts.commands_seen.length - 1; i >= 0; i--) {
          const c = facts.commands_seen[i];
          if (!failing.has(c) && !PROBE_RE.test(c) && kws.some(k => c.includes(k))) return c;
        }
        return null;
      };
      const BUILD_KW = ["npm run build", "make ", "cargo ", "go build", "mvn ", "gradle", "dotnet build", "vite build", "tsc -b", "pnpm run build"];
      const TEST_KW = ["pytest", "vitest", "jest", "go test", "ctest", "npm test", "python -m pytest", "pnpm test", "mvn test", "cargo test"];
      // 通用运行命令（如 python helloword.py / node script.js）——用户手动/多轮探索后最终成功
      const RUN_KW = ["python", "python3", "node ", "node.exe", "ruby", "perl ", "php ", "bash ", "sh ", "./"];
      const buildCmdRaw = lastSuccess(BUILD_KW);
      const testCmdRaw = lastSuccess(TEST_KW);
      const runCmdRaw = lastSuccess(RUN_KW);
      const buildCmd = buildCmdRaw ? `\nBuild: \`${buildCmdRaw}\`` : "";
      const body = (rt || "- <fill: runtime versions>") + buildCmd;
      // fix_prompt：精炼，分别给出构建/测试/运行最终成功命令 + 关键运行时版本（命令去重）
      const fpLines = [];
      if (buildCmdRaw) fpLines.push(`- 构建命令：\`${buildCmdRaw}\`（最终成功命令，直接使用，勿再试错）`);
      if (testCmdRaw && testCmdRaw !== buildCmdRaw) fpLines.push(`- 测试命令：\`${testCmdRaw}\`（最终成功命令，直接使用，勿再试错）`);
      if (runCmdRaw && runCmdRaw !== buildCmdRaw && runCmdRaw !== testCmdRaw) {
        fpLines.push(`- 运行命令：\`${runCmdRaw}\`（最终成功命令，直接使用，勿再试错）`);
      }
      // S1 运行时探测：提取最后成功的探测命令（如 py --version / node --version）
      // 探测失败转成功是关键信息——如 Windows 上 python 是 stub（退出码 49），py 才成功
      if (solved.includes('S1')) {
        const probeLast = (kws) => {
          for (let i = facts.commands_seen.length - 1; i >= 0; i--) {
            const c = facts.commands_seen[i];
            if (!failing.has(c) && kws.some(k => c.includes(k))) return c;
          }
          return null;
        };
        const probeCmd = probeLast(['--version', ' -v', 'which ', 'printenv', 'env ']);
        if (probeCmd) {
          const probeVer = facts.runtimes[probeCmd] || '';
          fpLines.push(`- 运行时探测：\`${probeCmd}\`${probeVer ? `（${probeVer}）` : ''}（最终成功命令，直接使用，勿再试错）`);
        }
      }
      if (rt) fpLines.push(rt.split("\n").map(l => l.replace(/^-\s*/, "- 运行时：")).join("\n"));
      const fixPrompt = fpLines.join("\n");
      blocks.push(new KnowledgeBlock("Runtimes & Commands", `## Runtimes\n${body}\n`, ["S1", "S3"], "script-extracted", inferScope("S1", facts), 0.9, fixPrompt));
    }
    if (solved.includes("S2") || solved.includes("S10")) {
      const paths = facts.paths_seen.slice(0, 10).map(p => `- ${p}`).join("\n") || "- <fill: key project paths>";
      blocks.push(new KnowledgeBlock("Project Map", `## Key paths\n${paths}\n`, ["S2", "S10"], "script", inferScope("S2", facts), 0.9));
    }
    if (solved.includes("S4")) {
      // 从后文提取最后成功的 git 命令（如 git commit / git push）
      const lastGit = lastSuccessBy(["git "]);
      const gitFixPrompt = lastGit
        ? `- git 命令：\`${lastGit}\`（最终成功命令，直接使用，勿再试错）`
        : "";
      blocks.push(new KnowledgeBlock("Git Conventions",
        "## Git\nDefault branch: <fill: branch name>\nAvoid interactive git (rebase -i)\n",
        ["S4"], "template", inferScope("S4", facts), 0.9, gitFixPrompt));
    }
    if (solved.some(s => ["S5", "S6", "S7", "S13"].includes(s))) {
      const failing = facts.failing_commands.slice(0, 8).map(c => `- \`${c}\``).join("\n") || "- <fill: failing commands>";
      const ss = ["S5", "S6", "S7", "S13"].filter(s => solved.includes(s));
      // S5（构建反复失败）/ S7（测试反复失败）：从后文提取最后成功命令
      let gotchaFixPrompt = "";
      if (solved.includes("S5") || solved.includes("S7")) {
        const fp = [];
        const lastBuild = lastSuccessBy(["npm run build", "make ", "cargo ", "go build", "mvn ", "gradle", "vite build", "pnpm run build", "tsc -b"]);
        if (lastBuild) fp.push(`- 构建命令：\`${lastBuild}\`（最终成功命令，直接使用，勿再试错）`);
        const lastTest = lastSuccessBy(["pytest", "vitest", "jest", "go test", "ctest", "npm test", "python -m pytest", "pnpm test", "mvn test"]);
        if (lastTest && lastTest !== lastBuild) fp.push(`- 测试命令：\`${lastTest}\`（最终成功命令，直接使用，勿再试错）`);
        gotchaFixPrompt = fp.join("\n");
      }
      blocks.push(new KnowledgeBlock("Build & Test Gotchas",
        `## Known failing commands — do not retry without change\n${failing}\n`,
        ss, "script-extracted", inferScope(ss[0] || "S5", facts), 0.9, gotchaFixPrompt));
    }
    if (solved.some(s => ["S8", "S9", "S16"].includes(s))) {
      const envLines = Object.entries(facts.env_vars).slice(0, 12).map(([k, v]) => `- ${k}=${v}`).join("\n");
      const envBody = envLines || "- <fill: env var name=value pairs>";
      const ss = ["S8", "S9", "S16"].filter(s => solved.includes(s));
      // fix_prompt：S16 环境变量探测预置值；S8 命令不存在（如 Windows python stub）→ 给出最终成功替代命令
      let fixPrompt = "";
      if (solved.includes("S16") && envLines) {
        fixPrompt = envLines.split("\n").map(l => "- 预置 " + l.replace("- ", "")).join("\n");
      }
      if (solved.includes("S8")) {
        // 提取最后成功的替代命令（如 python stub → py <脚本>）
        const altCmd = lastSuccessBy(["py ", "python3 ", "python ", "node ", "npm ", "git "]);
        if (altCmd) {
          const sep = fixPrompt ? "\n" : "";
          fixPrompt += `${sep}替代命令：\`${altCmd}\`（最终成功命令，直接使用，勿再试错）`;
        }
      }
      blocks.push(new KnowledgeBlock("Environment Variables", `## Env Vars\n${envBody}\n`, ss, "script-extracted", inferScope(ss[0] || "S8", facts), 0.9, fixPrompt));
    }
    if (solved.includes("S17")) {
      const missing = [];
      for (const v of verdicts) {
        if (v.scenario === "S17" && v.root_cause) {
          const m = v.root_cause.match(/`([^`]+)`/);
          if (m) missing.push(m[1]);
        }
      }
      const missingLine = missing.length > 0 ? missing.map(r => `\`${r}\``).join(", ") : "<fill: missing tool/package>";
      const failingSet = new Set(facts.failing_commands);
      let workaround = "";
      for (const cmd of facts.commands_seen) {
        if (!failingSet.has(cmd) && ["python3", "python", "node", "ruby", "perl", "awk", "sed"].some(k => cmd.includes(k))) {
          workaround = `\nWorkaround used: \`${cmd}\``;
          break;
        }
      }
      // fix_prompt：缺失资源的替代方案（从后文提取已成功的 workaround 命令）
      const prereqFixPrompt = workaround
        ? `- 替代方案：${workaround.replace('\nWorkaround used: ', '').replace(/`/g, '')}（已成功，直接使用，勿再重试失败命令）`
        : "";
      blocks.push(new KnowledgeBlock("Prerequisites & Required Tools",
        `## Prerequisites\nMissing in last session: ${missingLine}\nInstall: <fill: install command>${workaround}\n`,
        ["S17"], "script-extracted", inferScope("S17", facts), 0.9, prereqFixPrompt));
    }
    if (solved.includes("S18")) {
      const unused = [...new Set(trace.skills_available)].filter(s => !new Set(trace.skills_used).has(s)).sort();
      const usedLine = trace.skills_used.map(s => `\`${s}\``).join(", ") || "(none)";
      const unusedLines = unused.map(s => `- \`${s}\`: <fill: used for X — remove from settings if not needed for this project>`).join("\n") || "- <fill: skill name>";
      blocks.push(new KnowledgeBlock("Skill & MCP Usage",
        `## Loaded but Unused Skills\n${unusedLines}\nSkills actually used this session: ${usedLine}\nConsider removing unused skills from \`.legacy-state/settings.json\` to reduce per-turn token overhead.\n`,
        ["S18"], "script-extracted", inferScope("S18", facts), 0.9));
    }
    return [blocks, "环境/命令信息见 .ai-knowledge.md，勿重新探测。", { backend: "mock", calls: 0, cost_usd: 0.0 }];
  }
}

// ── 规则兜底：LLM 未生成 fix_prompt 时，从命令序列提取「最终成功命令」作为可直接合并的 prompt 内容 ──
function lastSuccessBy(trace, kws, exclude = null) {
  const events = (trace && trace.bashEvents ? trace.bashEvents() : []) || [];
  for (let i = events.length - 1; i >= 0; i--) {
    const c = (events[i].command || '').trim();
    if (!c || events[i].is_error) continue;
    if (kws.some(k => c.includes(k)) && (!exclude || !exclude(c))) return c;
  }
  return null;
}

/**
 * 精简最终成功命令：去掉 shell 噪音（cd 前缀、重定向、管道 tail/head 等），
 * 保留核心命令，使 fix_prompt 更简洁、可直接合并到步骤 prompt。
 * 例：`cd "D:/x" && python -m pytest tests -q 2>&1 | tail -3` → `python -m pytest tests -q`
 */
function cleanCmd(cmd) {
  let c = String(cmd || '').trim();
  // 去掉开头的 cd <dir> && （支持引号/括号）
  c = c.replace(/^(?:cd\s+[^;&]+?\s*&&\s*|cd\s+[^;&]+?\s*;?\s*)/i, '');
  // 去掉 cd 子 shell 包裹：(cd ... && ...)
  c = c.replace(/^\(\s*cd\s+[^;&]+?\s*&&\s*/, '').replace(/\s*\)\s*$/, '');
  // 去掉结尾管道与重定向（先管道后重定向，避免残留）
  c = c.replace(/\s*\|\s*(?:tail|head)\s+[^\s|&]+\s*$/i, '')
       .replace(/\s*\|\s*(?:grep|cat)\s+[^\s|&]+\s*$/i, '')
       .replace(/\s*>\s*[^\s|&]+(?:\s*2>&1)?\s*$/i, '')
       .replace(/\s*2>&1\s*$/i, '')
       .replace(/\s*2>\/dev\/null\s*$/i, '');
  // 去掉命令内部包裹双引号的多余部分？保留原样
  return c.trim();
}

/** 从命令历史逆序找解释器绝对路径（Windows C:\...\python.exe / Git Bash /c/.../python.exe 等） */
function findAbsInterpreter(trace) {
  const events = (trace && trace.bashEvents) ? trace.bashEvents() : [];
  // 强制匹配到解释器可执行文件（.exe 结尾或解释器名结尾），避免截断在中间目录
  const RE = /(?:[A-Za-z]:[\\/]|\/[c-z]\/|usr[/\\]bin|opt[/\\]|AppData|Programs|\.local)(?:[^\s;|&"]+[\\/])+[^\s;|&"]*(?:python3?|nodejs?|java|ruby|php)\.exe/i;
  for (let i = events.length - 1; i >= 0; i--) {
    const c = (events[i].command || '');
    if (events[i].is_error) continue;
    const m = c.match(RE);
    if (m) return m[0].trim();
  }
  return null;
}

export function fallbackFixPrompt(solves, trace, facts) {
  const lines = [];
  if (solves.includes('S1')) {
    const probe = lastSuccessBy(trace, ['--version', ' -v', 'which ', 'printenv', 'env ']);
    if (probe) {
      const ver = (facts.runtimes || {})[probe] || '';
      lines.push(`- 运行时探测：\`${probe}\`${ver ? `（${ver}）` : ''}（最终成功命令，直接使用，勿再试错）`);
    }
    // 解释器绝对路径：Windows 下 python 是 Store stub，直接给出真实解释器路径避免每次探测
    const abs = findAbsInterpreter(trace);
    if (abs) {
      lines.push(`- 解释器绝对路径：\`${abs}\`（Windows 下 \`python\` 是 Store stub，直接使用此绝对路径）`);
    }
  }
  const build = lastSuccessBy(trace, ["npm run build", "make ", "cargo ", "go build", "mvn ", "gradle", "vite build", "pnpm run build", "tsc -b"]);
  const test = lastSuccessBy(trace, ["pytest", "vitest", "jest", "go test", "ctest", "npm test", "python -m pytest", "pnpm test", "mvn test"]);
  if (solves.some(s => ['S3', 'S5', 'S7'].includes(s))) {
    if (build) lines.push(`- 构建命令：\`${cleanCmd(build)}\`（最终成功命令，直接使用，勿再试错）`);
    if (test && test !== build) lines.push(`- 测试命令：\`${cleanCmd(test)}\`（最终成功命令，直接使用，勿再试错）`);
  }
  if (solves.includes('S6')) {
    // lint 反复失败：给出最终成功的 lint 命令/配置
    const lint = lastSuccessBy(trace, ["eslint", "lint", "flake8", "pylint", "ruff", "tsc --noEmit", "prettier --check", "check --format"]);
    if (lint) lines.push(`- lint 命令：\`${cleanCmd(lint)}\`（最终成功命令，直接使用，勿再试错）`);
  }
  if (solves.some(s => ['S9', 'S21'].includes(s))) {
    // 依赖错误 / 包管理安装试错：给出最终成功的安装命令
    const install = lastSuccessBy(trace, ["npm install", "pnpm install", "pnpm add", "npm i", "pip install", "pip3 install", "python -m pip install", "go get", "cargo add", "cargo install", "gem install", "brew install"]);
    if (install) lines.push(`- 依赖安装命令：\`${cleanCmd(install)}\`（最终成功命令，直接使用，勿再试错）`);
  }
  if (solves.some(s => ['S22', 'S23'].includes(s))) {
    // 配置/初始化/工具链探测试错：给出最终成功的配置/工具链命令
    const cfg = lastSuccessBy(trace, ["cmake ", "configure ", "make ", "npm config", "pip config", "npmrc", "export ", "setx ", "set ", "init", "--config"]);
    if (cfg) lines.push(`- 配置/工具链命令：\`${cleanCmd(cfg)}\`（最终成功命令，直接使用，勿再试错）`);
  }
  if (solves.some(s => ['S2', 'S10', 'S11'].includes(s))) {
    // 结构探索 / import 找不到 / 重复读文件：给出项目关键路径（排除 CodeAgent 内部临时路径）
    const INTERNAL_RE = /Temp[\\/]codeagent|\.legacy-state[\\/]|node_modules|\.harness|[/\\]tasks[\\/]step-|\.output$/;
    const paths = (facts.paths_seen || [])
      .filter(p => !INTERNAL_RE.test(p))
      .slice(0, 5)
      .map(p => `\`${p}\``)
      .join('、');
    if (paths) lines.push(`- 项目关键路径：${paths}（直接引用，避免重复探索）`);
  }
  if (solves.includes('S4')) {
    const git = lastSuccessBy(trace, ['git ']);
    if (git) lines.push(`- git 命令：\`${cleanCmd(git)}\`（最终成功命令，直接使用，勿再试错）`);
  }
  if (solves.includes('S8')) {
    // 排除 harness 自身的 cli.js / 引擎命令，只留真实命令替代
    const alt = lastSuccessBy(trace, ["py ", "python3 ", "python ", "node ", "npm ", "git "], (c) => c.includes('cli.js') || c.includes('harness'));
    if (alt) lines.push(`- 替代命令：\`${cleanCmd(alt)}\`（最终成功命令，直接使用，勿再试错）`);
  }
  if (solves.includes('S16')) {
    const envLines = Object.entries(facts.env_vars || {}).slice(0, 6).map(([k, v]) => `- 预置 ${k}=${v}`);
    lines.push(...envLines);
  }
  return lines.join('\n');
}

export class CodeAgentFixer {
  constructor(model = "GLM-5.2-Auto(Volcano-MaaS)") { this.name = "codeagent"; this.model = model; }

  fix(verdicts, wiki, trace, facts, retriever = null) {
    const real = verdicts.filter(v => v.is_real);
    if (real.length === 0) return [[], "", { backend: this.name, calls: 0, cost_usd: 0.0 }];

    const problems = real.map(v =>
      `- ${v.scenario} (conf=${v.confidence}): ${v.root_cause}` + (v.evidence ? ` [evidence: ${v.evidence}]` : "")
    ).join("\n");

    const clusters = { S1: "C1", S2: "C1", S3: "C1", S4: "C2", S5: "C2", S6: "C2",
      S7: "C2", S8: "C3", S9: "C3", S10: "C3", S11: "C4", S12: "C4",
      S13: "C2", S14: "C4", S15: "C2", S16: "C1", S17: "C3", S18: "C1" };

    const sids = [], seen = new Set();
    for (const v of real) {
      for (const s of wiki.clusterSlices(clusters[v.scenario] || "misc").slice(0, 3)) {
        if (!seen.has(s.slice_id)) { seen.add(s.slice_id); sids.push(s); }
      }
    }

    const stats = { backend: this.name, calls: 0, cost_usd: 0.0, input_tokens: 0, output_tokens: 0, multi_round_calls: 0 };

    // 多轮对话：模型可通过 context_requests 调用 AI native 工具（getNextFragments 等）
    // 获取后续片段，找到最终成功的命令作为 fix_prompt
    const MAX_ROUNDS = 3;
    let round = 0;
    let contextResults = "";
    let parsed = null;

    while (round < MAX_ROUNDS) {
      round++;
      const prompt = FIX_PROMPT
        .replace("{problems}", problems)
        .replace("{facts}", JSON.stringify(facts, null, 1).slice(0, 2500))
        .replace("{slices}", _renderSlices(sids))
        .replace("{context_results}", contextResults);

      const res = callModel(prompt, this.model);
      stats.calls++;
      stats.cost_usd += res.cost_usd;
      stats.input_tokens += res.input_tokens;
      stats.output_tokens += res.output_tokens;
      if (round > 1) stats.multi_round_calls++;

      if (process.env.DEBUG) {
        console.log(`[fixer] round ${round}: prompt length=${prompt.length}, ok=${res.ok}, error=${JSON.stringify(res.error)}, text length=${res.text?.length || 0}`);
        if (!res.ok) console.error(`[fixer] round ${round} model call FAILED: error=${res.error}`);
      }

      // fallback: codeagent 不可用时降级到 mock 逻辑
      if (!res.ok && (res.error.includes("401") || res.error.includes("timeout") || res.error.includes("not found"))) {
        console.error(`[fixer] codeagent call failed (${res.error}), falling back to mock`);
        const mockFixer = new MockFixer();
        return mockFixer.fix(verdicts, wiki, trace, facts);
      }

      const parsedRound = res.ok ? extractJson(res.text) : null;
      if (!parsedRound || !parsedRound.knowledge_blocks) {
        console.error(`[fixer] round ${round}: failed to parse JSON`);
        break;
      }
      parsed = parsedRound;

      // 检查是否需要更多上下文（AI native 工具调用）
      const contextRequests = parsedRound.context_requests || [];
      if (contextRequests.length === 0 || round === MAX_ROUNDS || !retriever) {
        break;
      }

      // 执行工具调用
      console.log(`[fixer] round ${round}: executing ${contextRequests.length} context requests`);
      const toolResults = [];
      for (const req of contextRequests) {
        const result = this._executeToolCall(retriever, req);
        toolResults.push({ tool: req.tool, args: req.args, result });
      }
      contextResults = "\n\n[工具调用结果]\n" + JSON.stringify(toolResults, null, 2);
    }

    if (!parsed) return [[], "", stats];

    const blocks = (parsed.knowledge_blocks || [])
      .filter(b => b.markdown)
      .map(b => new KnowledgeBlock(
        b.title || "Untitled",
        b.markdown || "",
        b.solves || [],
        "model+facts",
        // LLM 返回 scope 优先，缺失时规则兜底（按 solves 中首个场景）
        b.scope === "organization" || b.scope === "personal"
          ? b.scope
          : inferScope((b.solves || [])[0] || "", facts),
        typeof b.confidence === "number" ? b.confidence : 0,
        // LLM 未生成 fix_prompt 时用规则兜底（提取最终成功命令，作为可直接合并的 prompt 内容）
        typeof b.fix_prompt === "string" && b.fix_prompt.trim()
          ? b.fix_prompt
          : fallbackFixPrompt(b.solves || [], trace, facts),
      ));

    return [blocks, parsed.claude_md_patch || "", stats];
  }

  // 执行 AI native 工具调用（只读）
  _executeToolCall(retriever, request) {
    const { tool, args } = request;
    try {
      switch (tool) {
        case "getNextFragments":
          return retriever.getNextFragments(args.slice_id, args.count || 2);
        case "getPreviousFragments":
          return retriever.getPreviousFragments(args.slice_id, args.count || 2);
        case "getFragmentById":
          return retriever.getFragmentById(args.slice_id);
        case "getSessionOverview":
          return retriever.getSessionOverview();
        default:
          return { error: `Unknown tool: ${tool}` };
      }
    } catch (err) {
      return { error: err.message };
    }
  }
}

export function getFixer(backend, model = null) {
  if (backend === "mock") return new MockFixer();
  return model ? new CodeAgentFixer(model) : new CodeAgentFixer();
}
