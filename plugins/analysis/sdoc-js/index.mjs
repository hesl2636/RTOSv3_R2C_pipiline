// index.mjs — 主入口
// 对照 Python cli.py 的 run 子命令（去掉 argparse CLI，改为 ES Module export）

import { run, writeKnowledge, writeAttribution } from './pipeline.mjs';
import { loadStepBoundaries } from './runstate-loader.mjs';

export { run, writeKnowledge, writeAttribution };

// 直接命令行调用：node index.mjs <session.jsonl> [--backend mock|codeagent] [--model ID] [--out DIR] [--auto-inject] [--project-root DIR] [--workflow FILE]
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 把多行引号标量折叠成单行（如 stepPrompt: 'line1\nline2...' 跨多行的旧格式）。
 * converter 已强制单行双引号（QuotedString），此折叠仅兼容历史包。
 * 折叠规则：值以 ' 或 " 开头且行内未闭合 → 收集后续行（trim）直到闭合引号。
 */
function _foldMultilineQuoted(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(/^(\s*[\w-]+:\s*)(['"])(.*)$/);
    if (m) {
      const quote = m[2];
      const rest = m[3];
      // 行内是否已闭合（单引号 '' 双写不算闭合）
      let closed = false;
      let j = 0;
      while (j < rest.length) {
        if (rest[j] === quote) {
          if (quote === "'" && rest[j + 1] === "'") { j += 2; continue; }
          closed = true;
          break;
        }
        j += 1;
      }
      if (!closed) {
        let buf = `${m[1]}${quote}${rest}`;
        let k = i + 1;
        while (k < lines.length) {
          const l = lines[k].trim();
          const idx = l.indexOf(quote);
          if (idx >= 0) {
            buf += l.slice(0, idx); // 闭合引号前的内容
            break;
          }
          buf += `\n${l}`;
          k += 1;
        }
        out.push(buf);
        i = k + 1;
        continue;
      }
    }
    out.push(line);
    i += 1;
  }
  return out;
}

/**
 * 简单的 YAML 解析器，提取 workflow 的步骤信息
 */
function _parseWorkflowYaml(content) {
  const steps = [];
  const lines = _foldMultilineQuoted(content.split('\n'));
  let currentStep = null;
  let inSteps = false;
  let inExpectations = false;
  let collectConfigured = null; // 正在收集的 configured 字段（configuredSkills/configuredMcps/configuredKbs）

  for (const line of lines) {
    const trimmed = line.trim();

    // 检测 steps 部分（只匹配顶层 steps:，跳过 stages 下的 steps:）
    // stages 下的 steps: 前面是 list item 的缩进，且值是数组引用（如 - step-explore）
    // 顶层 steps: 后面跟的是 - id: 格式的对象列表
    if (trimmed === 'steps:') {
      // 检查下一行是否是 "- id:" 格式，确认是顶层 steps
      const nextNonEmpty = lines.slice(lines.indexOf(line) + 1).find(l => l.trim());
      if (nextNonEmpty && (nextNonEmpty.trim().startsWith('- id:') || nextNonEmpty.trim().startsWith('-id:'))) {
        inSteps = true;
      }
      continue;
    }

    if (!inSteps) continue;

    // 如果遇到非 steps 部分的顶层 key（如 stages:），退出 steps
    if (trimmed === 'stages:' || trimmed === 'expectations:') {
      if (currentStep && currentStep.stepId) {
        steps.push(currentStep);
        currentStep = null;
      }
      inSteps = false;
      inExpectations = false;
      continue;
    }

    // 检测步骤开始（- id: step-xxx）
    if (trimmed.startsWith('- id:') || trimmed.startsWith('-id:')) {
      if (currentStep && currentStep.stepId) {
        steps.push(currentStep);
      }
      currentStep = {
        stepId: trimmed.replace(/^-?\s*id:\s*/, '').trim(), // 使用 stepId 而不是 id
        expectations: [],
      };
      inExpectations = false;
      collectConfigured = null;
      continue;
    }

    if (!currentStep) continue;

    // 检测 configured 字段（skill/mcp/知识库，供 S24-S26 检测"配置了但未使用"）
    if (trimmed.startsWith('configuredSkills:') || trimmed.startsWith('configuredMcps:') || trimmed.startsWith('configuredKbs:')) {
      const key = trimmed.split(':')[0].trim();
      if (!currentStep[key]) currentStep[key] = [];
      const inline = trimmed.slice(trimmed.indexOf(':') + 1).trim();
      if (inline) {
        // 内联数组 [a, b] 或单个值
        currentStep[key] = inline.replace(/[\[\]"']/g, '').split(',').map(s => s.trim()).filter(Boolean);
        collectConfigured = null;
     } else {
        collectConfigured = key; // 后续行是列表项
      }
      continue;
    }
    if (collectConfigured) {
      if (trimmed.startsWith('-')) {
        const val = trimmed.replace(/^-\s*/, '').replace(/["']/g, '').trim();
        if (val) currentStep[collectConfigured].push(val);
        continue;
      }
      if (trimmed !== '') {
        collectConfigured = null; // 缩进结束（非空行）退出收集
      } else {
        continue;
      }
    }

    // 检测 name
    if (trimmed.startsWith('name:')) {
      currentStep.name = trimmed.replace(/^name:\s*/, '').trim();
      continue;
    }

    // 检测主 skill（workflow.yaml 步骤声明的 skill: 字段，harness 引擎驱动执行的 skill）
    if (trimmed.startsWith('skill:')) {
      currentStep.skill = trimmed.replace(/^skill:\s*/, '').replace(/["']/g, '').trim();
      continue;
    }

    // 检测 taskFile（长 prompt 外置标记，供 S24-S26 定位 tasks/<stepId>.md 读取完整 prompt）
    if (trimmed.startsWith('taskFile:')) {
      currentStep.taskFile = trimmed.replace(/^taskFile:\s*/, '').replace(/["']/g, '').trim();
      continue;
    }

    // 检测 stepPrompt（内嵌步骤完整 prompt，供 S24-S26 判断 prompt 是否引导使用能力）
    // 已折叠为单行：单引号/双引号标量剥外层引号；普通值直接取
    if (trimmed.startsWith('stepPrompt:')) {
      const raw = trimmed.slice(trimmed.indexOf(':') + 1).trim();
      currentStep.stepPrompt = raw.replace(/^["']|["']$/g, '');
      continue;
    }

    // 检测 expectations
    if (trimmed === 'expectations:') {
      inExpectations = true;
      continue;
    }

    // 解析 expectation
    if (inExpectations && trimmed.startsWith('- id:')) {
      const exp = {
        id: trimmed.replace(/^-?\s*id:\s*/, '').trim(),
        kind: 'skill',
        match: '',
      };
      currentStep.expectations.push(exp);
      continue;
    }

    if (inExpectations && currentStep.expectations.length > 0) {
      const lastExp = currentStep.expectations[currentStep.expectations.length - 1];
      if (trimmed.startsWith('kind:')) {
        lastExp.kind = trimmed.replace(/^kind:\s*/, '').trim();
      } else if (trimmed.startsWith('match:')) {
        lastExp.match = trimmed.replace(/^match:\s*/, '').trim();
      }
    }
  }

  // 添加最后一个步骤
  if (currentStep && currentStep.stepId) {
    steps.push(currentStep);
  }

  return { steps };
}

if (process.argv[1] && process.argv[1].endsWith("index.mjs")) {
  const args = process.argv.slice(2);
  const sessionPath = args[0];
  if (!sessionPath) {
    console.error("Usage: node index.mjs <session.jsonl> [--backend mock|codeagent] [--model ID] [--out DIR] [--auto-inject] [--project-root DIR] [--run-id ID] [--workflow FILE]");
    process.exit(1);
  }

  const opts = {};
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--backend") opts.backend = args[++i];
    else if (args[i] === "--model") opts.model = args[++i];
    else if (args[i] === "--out") opts.outDir = args[++i];
    else if (args[i] === "--auto-inject") opts.autoInject = true;
    else if (args[i] === "--project-root") opts.projectRoot = args[++i];
    else if (args[i] === "--run-id") opts.runId = args[++i];
    else if (args[i] === "--legacy-plugin-root") opts.pluginRoot = args[++i];
    else if (args[i] === "--no-fix") opts.doFix = false;
    else if (args[i] === "--workflow") {
      // 读取 workflow YAML 并解析步骤信息
      const workflowPath = args[++i];
      try {
        const workflowContent = readFileSync(workflowPath, 'utf-8');
        // 简单的 YAML 解析，提取步骤信息
        opts.workflow = _parseWorkflowYaml(workflowContent);
        // workflow.yaml 没有时间戳信息，尝试从同目录的 trace/events.jsonl 补充
        // 这样 _buildSliceToStepMap 可以走时间戳匹配策略而非均匀分配
        if (opts.workflow.steps && opts.workflow.steps.length > 0) {
          const runStateDir = workflowPath.replace(/[/\\]workflow\.ya?ml$/, '');
          const eventsPath = join(runStateDir, 'trace', 'events.jsonl');
          if (existsSync(eventsPath)) {
            try {
              const { steps: tsSteps } = loadStepBoundaries(runStateDir);
              if (tsSteps && tsSteps.length > 0) {
                // 合并时间戳到 workflow.steps
                const tsMap = new Map(tsSteps.map(s => [s.stepId, s]));
                for (const step of opts.workflow.steps) {
                  const ts = tsMap.get(step.stepId);
                  if (ts) {
                    step.startTs = ts.startTs;
                    step.endTs = ts.endTs;
                    step.order = ts.order;
                  }
                }
              }
            } catch {
              // 时间戳补充失败不影响主流程
            }
          }
          // 合并 checkpoint 状态（state.json 的 steps[].status）：
          // harness 引擎直接执行 skill 不产生 tool_use Skill 记录，S24/S25/S26 检测时
          // 需要知道哪些 step 实际执行完成（checkpoint completed = 主 skill 已被引擎驱动执行）。
          try {
            const statePath = join(runStateDir, 'state.json');
            if (existsSync(statePath)) {
              const state = JSON.parse(readFileSync(statePath, 'utf-8'));
              const stateSteps = state.steps || {};
              const statusMap = new Map();
              for (const [stepId, info] of Object.entries(stateSteps)) {
                statusMap.set(stepId, (info && info.status) || '');
              }
              for (const step of opts.workflow.steps) {
                step.checkpointStatus = statusMap.get(step.stepId) || '';
              }
            }
          } catch {
            // checkpoint 状态补充失败不影响主流程
          }
        }
      } catch (e) {
        console.error(`Failed to read workflow file: ${workflowPath}`);
      }
    }
  }

  const rep = await run(sessionPath, opts);

  // 控制台输出
  console.log(`session ${rep.session_id.slice(0, 12)}  slices=${rep.slices}  backend=${rep.cost.analyze?.backend || 'unknown'}`);
  const m = rep.metrics;
  console.log(`指标: exploration_tokens=${m.exploration_tokens}  repeated_failures=${m.repeated_failures}  total_tokens=${m.total_tokens}  turns_to_first_edit=${m.turns_to_first_edit}`);
  console.log(`候选 ${rep.candidates.length} → 确认 real=${rep.confirmed_real}  误报=${rep.false_positives}  成本=$${rep.cost.total_usd}`);
  console.log("检测明细:");
  const vmap = {};
  for (const v of rep.verdicts) vmap[v.scenario] = v;
  for (const c of rep.candidates) {
    const v = vmap[c.scenario] || {};
    const mark = v.is_real ? "✓real" : "✗FP";
    console.log(`  [${c.scenario}] ${mark} conf=${v.confidence || "?"}  ${c.description}`);
    if (v.root_cause) console.log(`        根因: ${v.root_cause}`);
  }
  if (rep.knowledge_blocks.length > 0) {
    console.log(`知识块 ${rep.knowledge_blocks.length} 个:`);
    for (const b of rep.knowledge_blocks) {
      console.log(`  - ${b.title} (solves ${b.solves.join(", ")})`);
    }
  }

  if (opts.outDir) {
    mkdirSync(opts.outDir, { recursive: true });
    writeFileSync(join(opts.outDir, "report.json"), JSON.stringify(rep, null, 2), "utf-8");
    if (rep.knowledge_blocks.length > 0) {
      const kp = writeKnowledge(rep, opts.outDir);
      console.log(`\n📝 知识已写入: ${kp}`);
    }
    if (rep.attribution) {
      const ap = writeAttribution(rep, opts.outDir);
      console.log(`📊 归因报告已写入: ${ap}`);
    }
    console.log(`📄 完整报告: ${join(opts.outDir, "report.json")}`);
  }
  if (rep.auto_injected_path) {
    console.log(`💉 知识已注入项目: ${rep.auto_injected_path}`);
  }
}
