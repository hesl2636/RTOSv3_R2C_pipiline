// pipeline.mjs — 端到端编排：transcript → 诊断 + 知识产出
// 对照 Python pipeline.py

import { mkdirSync, writeFileSync, existsSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadTrace } from './adapter.mjs';
import { sliceSession } from './slicer.mjs';
import { runAll } from './detectors.mjs';
import { compute } from './metrics.mjs';
import { SessionWiki } from './wiki.mjs';
import { getConfirmer } from './confirmer.mjs';
import { getFixer, extractFacts } from './fixer.mjs';
import { Analyzer } from './analyzer.mjs';
import { MockAnalyzer } from './analyzer-mock.mjs';

/** 合并分析器工厂：backend=mock → MockAnalyzer；否则 Analyzer（codeagent） */
function getAnalyzer(backend, model = null) {
  if (backend === "mock") return new MockAnalyzer();
  return model ? new Analyzer(model) : new Analyzer();
}
import { EvidenceRetriever } from './evidence-retriever.mjs';
import { autoLoadStepBoundaries, buildStepWindows } from './runstate-loader.mjs';

export async function run(jsonlPath, options = {}) {
  const { backend = "mock", doFix = true, model = null, autoInject = false, projectRoot = null, workflow = null, runId = null, pluginRoot = null } = options;

  const trace = loadTrace(jsonlPath);
  const slices = sliceSession(trace);
  const wiki = new SessionWiki(slices);

  // 自动发现步骤边界（供 S24-S26 检测"配置了 skill/mcp/知识库但未使用"）：
  // 优先级：显式传入 workflow > 从 runs/ 目录自动发现 > 从 run-state/ 目录发现
  let effectiveWorkflow = workflow;
  if (!effectiveWorkflow && trace.session_id) {
    const { steps: runStateSteps, workflow: runStateWf, runDir } = autoLoadStepBoundaries(jsonlPath, trace.session_id, runId);
    if (runStateSteps && runStateSteps.length > 0) {
      effectiveWorkflow = { steps: runStateSteps };
    }
  }
  // 挂载插件根目录（S24-S26 读取外置任务文件 tasks/<stepId>.md 用）
  if (effectiveWorkflow && pluginRoot) {
    effectiveWorkflow.pluginRoot = pluginRoot;
  }

  const candidates = runAll(trace, slices, effectiveWorkflow);
  const m = compute(trace, candidates);

  // 合并分析器：每 cluster 一次 LLM 调用，同时输出判定（verdicts）+ 修复建议（fix_blocks）
  // 取代 confirmer + fixer 两阶段独立调用（快且上下文一致）
  const analyzer = getAnalyzer(backend, model);
  const actualModel = analyzer.model;  // 实际使用的模型名称

  // 创建 EvidenceRetriever 用于多轮对话（getNextFragments 等 AI native 工具）
  const retriever = new EvidenceRetriever(trace, slices, wiki);
  const facts = extractFacts(trace, slices);
  let blocks = [], verdicts = [], patch = "", fstats = { backend, calls: 0, cost_usd: 0.0 };
  if (doFix) {
    [verdicts, blocks, fstats] = await analyzer.analyze(candidates, wiki, trace, facts, retriever);
  } else {
    // --no-fix：仅判定，不生成修复建议
    const confirmer = getConfirmer(backend, model);
    [verdicts, fstats] = await confirmer.confirm(candidates, wiki, trace, retriever);
  }

  const realCount = verdicts.filter(v => v.is_real).length;
  const fpCount = verdicts.filter(v => !v.is_real).length;

  // auto-inject：仅个人级知识注入项目文件；组织级知识随 attribution 上传
  let injectedPath = null;
  const personalBlocks = blocks.filter(b => b.scope !== "organization");
  const orgBlocks = blocks.filter(b => b.scope === "organization");
  if (autoInject && projectRoot && personalBlocks.length > 0) {
    injectedPath = _injectKnowledge(personalBlocks, projectRoot);
  }


  return {
    session_id: trace.session_id,
    path: jsonlPath,
    slices: slices.length,
    metrics: m,
    candidates: candidates.map(c => c.toDict()),
    verdicts: verdicts.map(v => v.toDict()),
    confirmed_real: realCount,
    false_positives: fpCount,
    knowledge_blocks: blocks.map(b => b.toDict()),
    knowledge_md_patch: patch,
    facts,
    cost: {
      analyze: fstats,
      total_usd: Math.round((fstats.cost_usd || 0) * 1e6) / 1e6,
    },
    auto_injected_path: injectedPath,
    attribution: _buildAttribution(trace, candidates, verdicts, blocks, m, actualModel, fstats, effectiveWorkflow, slices, backend, orgBlocks),
  };
}

function _buildAttribution(trace, candidates, verdicts, blocks, metrics, model = "GLM-5.2-Auto(Volcano-MaaS)", cost = null, workflow = null, slices = null, backend = "mock", orgBlocks = []) {
  const executionFailureItems = [];
  const resourceAnomalyItems = [];

  // 构建 scenario → fix_prompt 映射（从知识块的 fixPrompt 字段提取）。
  // S24/S25/S26 是 per-candidate 的：同一 scenario 下每个能力（skill/mcp/kb）的
  // fix_prompt 不同，需额外按能力名索引（从 fix_prompt/title 反引号内容提取），
  // 避免所有候选共享第一个 block 的 fix_prompt。
  const fixPromptByScenario = {};
  const fixPromptByCapability = {};
  for (const b of blocks) {
    // block 字段可能是 fix_prompt（sdoc-js 产物）或 fixPrompt（历史格式），兼容两者
    const fp = b.fix_prompt || b.fixPrompt;
    if (fp && b.solves) {
      // 从 fix_prompt 或 title 提取反引号能力名（如 `comet-open` / `mcp__xxx`）
      const capMatch = String(fp).match(/`([^`]+)`/) || String(b.title || "").match(/`([^`]+)`/);
      const cap = capMatch ? capMatch[1].trim() : "";
      for (const s of b.solves) {
        if (!fixPromptByScenario[s]) fixPromptByScenario[s] = fp;
        if (cap) {
          const key = `${s}:${cap}`;
          if (!fixPromptByCapability[key]) fixPromptByCapability[key] = fp;
        }
      }
    }
  }

  // S24/S25/S26 item 按能力名取 fix_prompt；无能力名匹配时回退 scenario 级
  const fixPromptFor = (scenario, capabilityName) => {
    if (capabilityName && fixPromptByCapability[`${scenario}:${capabilityName}`]) {
      return fixPromptByCapability[`${scenario}:${capabilityName}`];
    }
    return fixPromptByScenario[scenario] || "";
  };

  // 构建 slice → step 的映射（如果有 workflow 信息）
  const sliceToStep = {};
  if (workflow && slices) {
    _buildSliceToStepMap(workflow, slices, trace, sliceToStep);
  }

  // 构建 slice_id → slice 对象的映射，用于提取 tool_use_ids
  const sliceById = {};
  if (slices) {
    for (const s of slices) {
      sliceById[s.slice_id] = s;
    }
  }

  // 使用索引匹配，避免同 scenario 多候选碰撞
  // confirmer 按候选顺序返回 verdicts，索引一一对应
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const v = verdicts[i] || {};
    const categories = _inferCategories(c.scenario, v.category);

    // S24/S25/S26：优先用 LLM 按能力名生成的 fix_prompt；未覆盖时规则兜底
    const cfgCap = ((c.metrics && c.metrics.items) || [])[0] || {};
    const cfgCapName = cfgCap.skill || cfgCap.mcp || cfgCap.kb || "";
    let cfgFixPrompt = fixPromptFor(c.scenario, cfgCapName);
    if (!cfgFixPrompt && ['S24', 'S25', 'S26'].includes(c.scenario)) {
      const capType = c.scenario === 'S24' ? 'skill' : c.scenario === 'S25' ? 'MCP server' : '知识库';
      const summary = cfgCap.skillSummary || "";
      if (cfgCapName) {
        cfgFixPrompt = `- 本步骤配置了 ${capType} \`${cfgCapName}\` 但未调用；请在步骤 prompt 中明确引导调用${summary ? `（该能力用途：${summary.slice(0, 120)}）` : ''}`;
      }
    }

    for (const category of categories) {
      const item = {
        scenario: c.scenario,
        category,
        is_real: v.is_real,
        confidence: v.confidence,
        root_cause: v.root_cause ? _adaptRootCause(v.root_cause, c.scenario, category) : v.root_cause,
        evidence: v.evidence,
        suggestion: _inferSuggestion(c.scenario, category),
        fix_prompt: cfgFixPrompt,
        wasted_tokens_est: c.wasted_tokens_est,
        wasted_time_est: c.wasted_time_est || 0,
      };

      // 如果有步骤映射，为归因项添加 step_id
      if (c.slice_ids && c.slice_ids.length > 0) {
        const stepIds = new Set();
        for (const sliceId of c.slice_ids) {
          if (sliceToStep[sliceId]) {
            stepIds.add(sliceToStep[sliceId]);
          }
        }
        if (stepIds.size > 0) {
          item.step_id = [...stepIds].join(',');
        }
      } else if (['S24', 'S25', 'S26'].includes(c.scenario)) {
        // S24/S25/S26 配置偏差类：slice_ids 为空（配置 vs 未调用，无执行切片），
        // 顶层 item 的 step_id 从 candidate metrics.items[].stepId 提取，
        // 与 step_attribution 构建逻辑一致——否则顶层列表缺 step_id，
        // 前端无法将 S24 归因项关联到具体步骤，看起来像"少了一个"。
        // 注意：一个 candidate 的 metrics.items 通常只有一个 step（按 step 拆分 candidate），
        // 多个时用逗号拼接。
        const cfgStepIds = new Set();
        for (const cfgItem of ((c.metrics && c.metrics.items) || [])) {
          if (cfgItem.stepId) cfgStepIds.add(cfgItem.stepId);
        }
        if (cfgStepIds.size > 0) {
          item.step_id = [...cfgStepIds].join(',');
        }
      }

      // S24/S25/S26：携带具体未调用的能力名（skill/mcp/kb），供前端按名匹配期望行。
      // 顶层 item 需与 step_attribution 内部 item 一致——
      // 否则顶层 resource_anomaly_attribution 的 S24 项缺 capability_name，
      // 前端无法按能力名匹配 deviation 的 expected-missing 行。
      if (['S24', 'S25', 'S26'].includes(c.scenario) && cfgCapName) {
        item.capability_name = cfgCapName;
      }

      // 从 candidate 的 slice_ids 中提取所有 tool_use_id
      // 用于前端"查看执行记录"跳转到对应的 session 片段
      if (c.slice_ids && c.slice_ids.length > 0) {
        const toolUseIds = [];
        for (const sliceId of c.slice_ids) {
          const sl = sliceById[sliceId];
          if (sl && sl.events) {
            for (const e of sl.events) {
              if (e.type === 'tool_call' && e.tool_use_id) {
                toolUseIds.push(e.tool_use_id);
              }
            }
          }
        }
        if (toolUseIds.length > 0) {
          item.tool_use_ids = toolUseIds;
        }
      }

      if (category === "execution_failure") {
        executionFailureItems.push(item);
      } else {
        resourceAnomalyItems.push(item);
      }
    }
  }

  const time_breakdown = {
    exploration: {
      tokens: metrics.exploration_tokens,
      description: "首次代码编辑前的探索消耗",
    },
    runtime_probing: {
      tokens: _sumWasted(candidates, ["S1"]),
      count: _countCandidates(candidates, ["S1"]),
      description: "运行时版本/路径探测",
    },
    command_trial: {
      tokens: _sumWasted(candidates, ["S3"]),
      count: _countCandidates(candidates, ["S3"]),
      description: "build/test/lint 命令试错",
    },
    repeated_failures: {
      tokens: _sumWasted(candidates, ["S4", "S5", "S7"]),
      count: _countCandidates(candidates, ["S4", "S5", "S7"]),
      description: "反复失败",
    },
    redundant_reads: {
      tokens: _sumWasted(candidates, ["S11"]),
      count: _countCandidates(candidates, ["S11"]),
      description: "重复读同文件",
    },
    total_wasted: metrics.wasted_tokens_est,
  };

  // 生成步骤级归因数据
  // 参考 ca-viewer：每个步骤都必须出现在 step_attribution 中，
  // 即使没有归因项也输出空数组，这样前端才能看到所有步骤
  //
  // 关键原则：每个步骤只分析该步骤内执行的内容。
  // 当一个 candidate 的 slice_ids 跨多个步骤时，按 slice 归属拆分：
  //   - 每个步骤只包含映射到该步骤的 slice 对应的归因项
  //   - evidence 只引用该步骤内的 slice
  //   - step_id 只写当前步骤（而非所有涉及的步骤）
  //   - wasted_tokens_est 按该步骤内 slice 的 token 占比分摊
  const step_attribution = {};
  if (workflow && workflow.steps) {
    // 构建 slice → slice 对象的映射，用于计算 token 占比
    const sliceMap = {};
    if (slices) {
      for (const s of slices) {
        sliceMap[s.slice_id] = s;
      }
    }

    for (const step of workflow.steps) {
      const stepExec = [];
      const stepResource = [];

      // 遍历所有 candidate，按 slice 归属拆分到当前步骤
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        const v = verdicts[i] || {};
        const categories = _inferCategories(c.scenario, v.category);

        // 找出属于当前步骤的 slice_ids
        const stepSliceIds = (c.slice_ids || []).filter(sid => sliceToStep[sid] === step.stepId);
        // S24/S25/S26 等配置偏差类候选无 slice_ids（配置 vs 未调用，无执行切片）：
        // 按配置步骤归属——metrics.items[].step 记录的是配置该 skill/mcp/知识库的步骤名
        const isConfiguredStep = (c.slice_ids || []).length === 0 && ((c.metrics && c.metrics.items) || [])
          .some(it => it.step === step.name);
        if (stepSliceIds.length === 0 && !isConfiguredStep) continue;

        // 计算当前步骤内 slice 的 token 占比，用于分摊 wasted_tokens_est
        const stepSliceTokens = stepSliceIds.reduce((sum, sid) => {
          const sl = sliceMap[sid];
          return sum + (sl ? sl.token_cost || 0 : 0);
        }, 0);
        const totalSliceTokens = (c.slice_ids || []).reduce((sum, sid) => {
          const sl = sliceMap[sid];
          return sum + (sl ? sl.token_cost || 0 : 0);
        }, 0);
        const tokenRatio = isConfiguredStep ? 1 : (totalSliceTokens > 0 ? stepSliceTokens / totalSliceTokens : (stepSliceIds.length / (c.slice_ids || []).length));

        // 从当前步骤的 slice 中提取 tool_use_id
        const stepToolUseIds = [];
        // 当前 candidate 在该步骤的所有 slice 的整体时间跨度（首 slice 首事件 ts → 尾 slice 尾事件 ts）。
        // 用于步骤级 wasted_time_est——时间应按墙钟跨度计算，不能用 token 占比分摊
        // （token 占比只反映 token 消耗比例，与时间跨度无关，用它会严重低估/高估耗时）。
        // 注意：取整体首尾（而非单 slice 最大跨度），保证重复失败（多个短 slice）的累积耗时被正确计入。
        // 起点用首事件发起 ts，终点用末事件完成 resultTs（含执行时长，避免并发执行低估）。
        let stepTimeSpanSec = 0;
        const stepStartTs = [];
        const stepEndTs = [];
        for (const sid of stepSliceIds) {
          const sl = sliceMap[sid];
          if (sl && sl.events) {
            for (const e of sl.events) {
              if (e.type === 'tool_call' && e.tool_use_id) {
                stepToolUseIds.push(e.tool_use_id);
              }
            }
            for (const ev of sl.events) {
              if (ev.ts) stepStartTs.push(ev.ts);
              if (ev.resultTs || ev.ts) stepEndTs.push(ev.resultTs || ev.ts);
            }
          }
        }
        if (stepStartTs.length >= 1 && stepEndTs.length >= 1) {
          const startMs = new Date(stepStartTs.sort()[0]).getTime();
          const endMs = new Date(stepEndTs.sort()[stepEndTs.length - 1]).getTime();
          if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs) {
            const span = Math.round((endMs - startMs) / 1000);
            if (span > 0) stepTimeSpanSec = span;
          }
        }

        for (const category of categories) {
          const item = {
            scenario: c.scenario,
            category,
            is_real: v.is_real,
            confidence: v.confidence,
            root_cause: v.root_cause ? _adaptRootCause(v.root_cause, c.scenario, category) : v.root_cause,
            evidence: _filterEvidenceBySlices(v.evidence, stepSliceIds),
            suggestion: _inferSuggestion(c.scenario, category),
            fix_prompt: fixPromptByScenario[c.scenario] || "",
            wasted_tokens_est: c.wasted_tokens_est ? Math.round(c.wasted_tokens_est * tokenRatio) : c.wasted_tokens_est,
            // 时间按当前步骤 slice 的真实墙钟跨度计算（而非 token 占比分摊）：
            // 步骤内 slice 有 ≥2 个事件时用首尾差值；否则回退到全局时间 * tokenRatio（兜底）
            wasted_time_est: stepTimeSpanSec > 0
              ? stepTimeSpanSec
              : (c.wasted_time_est ? Math.round(c.wasted_time_est * tokenRatio) : (c.wasted_time_est || 0)),
            step_id: step.stepId,
          };

          // S24/S25/S26：携带具体未调用的能力名（skill/mcp/kb），供前端按名匹配期望行；
          // fix_prompt 优先用 LLM 按能力名生成的（fixPromptFor），未覆盖时规则兜底
          if (isConfiguredStep) {
            const cfgItem = ((c.metrics && c.metrics.items) || []).find(it => it.step === step.name);
            if (cfgItem) {
              if (cfgItem.skill) item.capability_name = cfgItem.skill;
              else if (cfgItem.mcp) item.capability_name = cfgItem.mcp;
              else if (cfgItem.kb) item.capability_name = cfgItem.kb;
              if (item.capability_name) {
                item.fix_prompt = fixPromptFor(c.scenario, item.capability_name) || item.fix_prompt;
                if (!item.fix_prompt) {
                  const capType = c.scenario === 'S24' ? 'skill' : c.scenario === 'S25' ? 'MCP server' : '知识库';
                  const summary = cfgItem.skillSummary || "";
                  item.fix_prompt = `- 本步骤配置了 ${capType} \`${item.capability_name}\` 但未调用；请在步骤 prompt 中明确引导调用${summary ? `（该能力用途：${summary.slice(0, 120)}）` : ''}`;
                }
              }
            }
          }

          // 添加该步骤内的 tool_use_ids，用于前端跳转
          if (stepToolUseIds.length > 0) {
            item.tool_use_ids = stepToolUseIds;
          }

          if (category === "execution_failure") {
            stepExec.push(item);
          } else {
            stepResource.push(item);
          }
        }
      }

      // 始终输出每个步骤，即使归因项为空
      step_attribution[step.stepId] = {
        execution_failure_attribution: stepExec,
        resource_anomaly_attribution: stepResource,
      };
    }
  }

  const result = {
    session_id: trace.session_id,
    analyzed_at: new Date().toISOString(),
    backend: backend,
    model: model,
    metrics: {
      exploration_tokens: metrics.exploration_tokens,
      repeated_failures: metrics.repeated_failures,
      total_tokens: metrics.total_tokens,
      wasted_tokens_est: metrics.wasted_tokens_est,
      wasted_time_est: metrics.wasted_time_est || 0,
      candidate_count: candidates.length,
    },
    execution_failure_attribution: executionFailureItems,
    resource_anomaly_attribution: resourceAnomalyItems,
    time_breakdown,
    cost: cost ? {
      calls: cost.calls || 0,
      cost_usd: cost.cost_usd || 0,
      input_tokens: cost.input_tokens || 0,
      output_tokens: cost.output_tokens || 0,
      multi_round_calls: cost.multi_round_calls || 0,
    } : null,
  };

  // 始终输出 step_attribution（即使为空对象），前端依赖此字段判断步骤拆分是否生效
  result.step_attribution = step_attribution;

  // 组织级知识块（scope=organization）附加到 attribution，随上传进入组织知识候选池
  if (orgBlocks && orgBlocks.length > 0) {
    result.organization_knowledge_blocks = orgBlocks.map(b => b.toDict());
  }

  return result;
}

/**
 * 构建 slice → step 的映射
 *
 * 参考 ca-viewer 的 resolveTurnBindings.ts，采用时间窗口归属算法：
 *   1. 时间窗口匹配：将步骤事件折成 [startAt, endAt) 窗口，
 *      按 slice 首事件时间戳落窗归属，一个 slice 只计入一个步骤
 *   2. 期望匹配：如果步骤有 expectations，匹配 slice 中的工具调用
 *   3. 顺序分配：对仍未映射的 slice，按步骤顺序依次分配
 *
 * 三条纪律（与 ca-viewer 一致）：
 *   - 窗口是 [start, end)：slice 恰好开始于某步 completed 时刻时归下一步
 *   - 未闭合窗口延伸到下一步 started 或正无穷
 *   - 归属不到任何窗口的 slice 显式记录，不静默塞给最近的步骤
 */
/**
 * 过滤 evidence 文本，只保留属于当前步骤的 slice 引用
 *
 * evidence 格式通常是 "slice xxx: ...; slice yyy: ..."
 * 只保留 stepSliceIds 中包含的 slice 引用，移除不属于当前步骤的 slice
 */
function _filterEvidenceBySlices(evidence, stepSliceIds) {
  if (!evidence || stepSliceIds.length === 0) return evidence;

  // 提取 stepSliceIds 中的短 ID（去掉 session 前缀，如 "8ea059c8-sl0032" → "sl0032"）
  const shortIds = new Set(stepSliceIds.map(id => {
    const dashIdx = id.lastIndexOf('-');
    return dashIdx >= 0 ? id.slice(dashIdx + 1) : id;
  }));

  // 按 "slice xxx:" 分割 evidence，保留属于当前步骤的片段
  // evidence 格式: "slice sl0032: xxx; slice sl0041: yyy"
  const segments = evidence.split(/(?=slice\s+\S+[:：])/i);
  const kept = [];

  for (const seg of segments) {
    // 提取本段引用的 slice ID
    const m = seg.match(/slice\s+(\S+)[:：]/i);
    if (!m) {
      // 没有匹配到 slice 引用的文本，保留（可能是开头或连接文本）
      kept.push(seg);
      continue;
    }
    const refId = m[1];
    // 检查是否属于当前步骤（完整 ID 或短 ID 匹配）
    const isOurs = stepSliceIds.includes(refId) || shortIds.has(refId);
    if (isOurs) {
      kept.push(seg);
    }
  }

  const filtered = kept.join('').trim();
  return filtered || evidence; // 如果过滤后为空，返回原始 evidence
}

function _buildSliceToStepMap(workflow, slices, trace, map) {
  // workflow 可能是 { steps: [...] } 或 { workflow: { steps: [...] } }
  const steps = workflow.steps || (workflow.workflow && workflow.workflow.steps);
  if (!steps || steps.length === 0) return;

  const totalSlices = slices.length;
  if (steps.length === 0 || totalSlices === 0) return;

  // 策略 1：时间窗口匹配（参考 ca-viewer 的 resolveTurnBindings）
  const hasTimestamps = steps.some(s => s.startTs);
  if (hasTimestamps) {
    // 构建步骤时间窗口
    const allWindows = buildStepWindows(steps);
    // 排除系统步骤（Upload/Analyze Session 等 harness 内部步骤）：
    // 用户命令（如交付后手动验证）时间晚于系统步骤开始，会被无限窗口吞掉，
    // 应归到最近的用户步骤而非 Analyze Session
    const SYSTEM_STEP_RE = /upload|analyze|session|收集|上传|分析/i;
    const windows = allWindows.filter(w => {
      const step = steps.find(s => s.stepId === w.stepId);
      const name = step?.name || step?.id || '';
      return !SYSTEM_STEP_RE.test(name);
    });

    if (windows.length > 0) {
      // 按 slice 首事件时间戳落窗归属
      for (const slice of slices) {
        if (map[slice.slice_id]) continue; // 已映射

        // 取 slice 第一个事件的时间戳
        const sliceTs = slice.events[0]?.ts;
        if (!sliceTs) continue;
        const sliceMs = new Date(sliceTs).getTime();
        if (isNaN(sliceMs)) continue;

        // 找到包含此时间戳的窗口 [startAt, endAt)
        for (const win of windows) {
          const startMs = new Date(win.startAt).getTime();
          const endMs = win.endAt ? new Date(win.endAt).getTime() : Infinity;

          if (sliceMs >= startMs && sliceMs < endMs) {
            map[slice.slice_id] = win.stepId;
            break;
          }
        }
      }

      // 对于未匹配的 slice，按时间顺序找最近的步骤（在所有窗口之前的活动）
      const unmappedWithTs = slices.filter(s => !map[s.slice_id] && s.events[0]?.ts);
      if (unmappedWithTs.length > 0) {
        // 按步骤开始时间排序
        const sortedWindows = [...windows].sort((a, b) =>
          new Date(a.startAt).getTime() - new Date(b.startAt).getTime()
        );

        for (const slice of unmappedWithTs) {
          const sliceMs = new Date(slice.events[0].ts).getTime();

          // 找到 slice 时间戳之前最近的步骤窗口
          let bestStep = null;
          let bestStart = -Infinity;
          for (const win of sortedWindows) {
            const startMs = new Date(win.startAt).getTime();
            if (startMs <= sliceMs && startMs > bestStart) {
              bestStart = startMs;
              bestStep = win.stepId;
            }
          }
          if (bestStep) {
            map[slice.slice_id] = bestStep;
          }
        }
      }
    }
  }

  // 策略 2：期望匹配（对未映射的 slice）
  for (const step of steps) {
    if (!step.expectations || step.expectations.length === 0) continue;

    for (const slice of slices) {
      if (map[slice.slice_id]) continue; // 已经映射过了

      for (const event of slice.events) {
        if (event.type !== 'tool_call') continue;
        for (const exp of step.expectations) {
          if (_matchesExpectation(event, exp)) {
            map[slice.slice_id] = step.stepId;
            break;
          }
        }
        if (map[slice.slice_id]) break;
      }
    }
  }

  // 策略 3：顺序分配（对仍未映射的 slice）
  // 不再使用均匀分配，改为按步骤顺序依次分配，保持 slice 原始顺序与步骤顺序的对应关系
  const unmappedSlices = slices.filter(s => !map[s.slice_id]);
  if (unmappedSlices.length > 0) {
    const sortedSteps = [...steps].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    // 计算每个步骤已有的 slice 数量
    const stepSliceCount = {};
    for (const step of sortedSteps) {
      stepSliceCount[step.stepId] = 0;
    }
    for (const slice of slices) {
      if (map[slice.slice_id]) {
        stepSliceCount[map[slice.slice_id]] = (stepSliceCount[map[slice.slice_id]] || 0) + 1;
      }
    }

    // 按顺序将未映射的 slice 分配给 slice 最少的步骤
    // 保持 slice 的原始顺序与步骤顺序的对应关系
    const slicesPerStep = Math.ceil(unmappedSlices.length / sortedSteps.length);
    for (let i = 0; i < sortedSteps.length; i++) {
      const startIdx = i * slicesPerStep;
      const endIdx = Math.min((i + 1) * slicesPerStep, unmappedSlices.length);
      for (let j = startIdx; j < endIdx; j++) {
        if (unmappedSlices[j]) {
          map[unmappedSlices[j].slice_id] = sortedSteps[i].stepId;
        }
      }
    }
  }
}

/**
 * 检查事件是否匹配期望
 */
function _matchesExpectation(event, expectation) {
  const toolName = event.tool_name || '';
  const command = event.command || '';

  switch (expectation.kind) {
    case 'skill':
      return toolName === 'Skill' && (event.tool_input?.skill || '').includes(expectation.match);
    case 'mcp':
      return toolName === 'mcp' && (event.tool_input?.server || '').includes(expectation.match);
    case 'shell':
      if (toolName !== 'Bash') return false;
      if (expectation.matchMode === 'prefix') {
        return command.startsWith(expectation.match);
      }
      return command.includes(expectation.match);
    case 'output':
      // 检查是否写入了期望的文件
      return (event.file_paths || []).some(p => p.includes(expectation.match));
    case 'agent':
      return toolName === 'Agent' && (event.tool_input?.agent || '').includes(expectation.match);
    default:
      return false;
  }
}

// 执行失败类：操作本身返回了错误（命令不存在、skill 报错、MCP 报错等）
const EXECUTION_FAILURE = new Set(["S8", "S9", "S10", "S15", "S19", "S20"]);
// 资源消耗异常类：操作可能成功但浪费了时间/token（重复读、空搜索、探测等）
const RESOURCE_ANOMALY = new Set(["S1", "S2", "S3", "S11", "S12", "S16", "S18"]);
// 跨类问题：操作既有失败又可能浪费资源，由模型判定主分类
const CROSS_CATEGORY = new Set(["S4", "S5", "S6", "S7", "S13", "S14", "S17"]);

function _inferCategories(scenario, verdictCategory = null) {
  // 优先使用模型返回的 category 判定
  if (verdictCategory && (verdictCategory === "execution_failure" || verdictCategory === "resource_anomaly")) {
    return [verdictCategory];
  }
  // 脚本侧 fallback
  if (EXECUTION_FAILURE.has(scenario)) return ["execution_failure"];
  if (RESOURCE_ANOMALY.has(scenario)) return ["resource_anomaly"];
  if (CROSS_CATEGORY.has(scenario)) return ["execution_failure"];
  return ["execution_failure"];
}

// 对于跨类问题，根据 category 调整 root_cause 的表述角度
function _adaptRootCause(rootCause, scenario, category) {
  if (!rootCause) return rootCause;
  // 如果是跨类问题且 root_cause 中包含"项目笔记应记录"等晦涩表述，根据分类调整
  if (CROSS_CATEGORY.has(scenario)) {
    if (category === "execution_failure") {
      // 执行失败角度：关注操作为什么失败
      return rootCause.replace(/项目笔记应记录/g, "请检查并修复");
    } else if (category === "resource_anomaly") {
      // 资源消耗角度：关注为什么会浪费时间
      return rootCause.replace(/项目笔记应记录/g, "建议在项目文档中预置");
    }
  }
  return rootCause;
}

function _inferSuggestion(scenario, category = null) {
  const suggestions = {
    S1: {
      execution_failure: null,
      resource_anomaly: "在项目 markdown 中预置运行时版本信息（如 `node -v` / `python --version` 的预期输出），避免 AI 每次都去探测",
    },
    S2: {
      execution_failure: null,
      resource_anomaly: "在项目 markdown 中预置项目结构说明，避免 AI 过度探索",
    },
    S3: {
      execution_failure: null,
      resource_anomaly: "在项目 markdown 中预置正确的构建/测试/lint 命令，或在工作流中编排脚本固定命令，避免 AI 试错",
    },
    S4: {
      execution_failure: "请检查 git 配置是否正确，确认分支名、远程仓库地址等是否可用",
      resource_anomaly: "在项目 markdown 中预置 git 规范（默认分支、提交格式），避免 AI 反复试错",
    },
    S5: {
      execution_failure: "请检查构建失败的具体错误，修复依赖或配置问题后重试",
      resource_anomaly: "在项目 markdown 中记录已知构建问题和解决方案，避免 AI 反复踩坑",
    },
    S6: {
      execution_failure: "请检查 lint 报错的具体规则，修复代码后重试",
      resource_anomaly: "在项目 markdown 中提示先跑 formatter 再手动修复，避免 lint→edit→lint 循环",
    },
    S7: {
      execution_failure: "请检查测试环境配置，确认测试依赖是否安装、测试数据是否就绪",
      resource_anomaly: "在项目 markdown 中记录测试环境配置步骤，避免 AI 反复试错",
    },
    S8: {
      execution_failure: "请检查命令是否正确安装、PATH 是否配置，或在项目 markdown 中列出可用命令",
      resource_anomaly: null,
    },
    S9: {
      execution_failure: "请检查依赖安装步骤、权限配置、网络代理设置，或在工作流中编排环境初始化脚本",
      resource_anomaly: null,
    },
    S10: {
      execution_failure: "请检查依赖是否安装、模块路径是否正确，或在项目 markdown 中记录依赖安装步骤",
      resource_anomaly: null,
    },
    S11: {
      execution_failure: null,
      resource_anomaly: "在 AGENTS.md 中提示避免重复读同一文件，或在工作流中缓存文件内容",
    },
    S12: {
      execution_failure: null,
      resource_anomaly: "在项目 markdown 中预置文件搜索关键词和位置，避免 AI 盲猜",
    },
    S13: {
      execution_failure: "请检查 Edit 的 old_string 是否与文件内容完全匹配，确保文件未被外部修改",
      resource_anomaly: "在 AGENTS.md 中提示 Edit 前先 Read 确认内容，避免编辑失败后重试",
    },
    S14: {
      execution_failure: "请检查 bash 命令是否正确，或改用 Read/Edit/Grep 等专用工具",
      resource_anomaly: "在 AGENTS.md 中提示使用 Read/Grep/Glob 而非 bash 命令，减少低效操作",
    },
    S15: {
      execution_failure: "请在代码修改后运行测试/构建/lint 验证，确保改动正确",
      resource_anomaly: null,
    },
    S16: {
      execution_failure: null,
      resource_anomaly: "在项目 markdown 中预置环境变量值，或在工作流中编排脚本配置环境变量，避免 AI 探测",
    },
    S17: {
      execution_failure: "请检查缺失的依赖/工具是否安装，或在项目 markdown 中记录安装步骤",
      resource_anomaly: "在项目 markdown 中记录缺失资源及安装方法，避免 AI 反复重试",
    },
    S18: {
      execution_failure: null,
      resource_anomaly: "从 .cac/settings.json 移除不需要的 skill，减少 token 开销",
    },
    S19: {
      execution_failure: "请检查 skill 配置是否正确，确认 skill 脚本路径和依赖是否可用；或在项目 markdown 中说明 skill 的前置条件",
      resource_anomaly: null,
    },
    S20: {
      execution_failure: "请检查 MCP 服务器配置和网络连接，确认 MCP 服务是否可用；或在项目 markdown 中说明哪些 MCP 服务不可用",
      resource_anomaly: null,
    },
    S24: {
      execution_failure: null,
      resource_anomaly: "在步骤 prompt 中明确引导调用该 skill（说明该 skill 用途与本步骤任务的契合点、调用时机），或将确实不需要的 skill 从步骤配置中移除",
    },
    S25: {
      execution_failure: null,
      resource_anomaly: "在步骤 prompt 中明确引导调用该 MCP server（说明用途与调用时机），或将确实不需要的 MCP 从步骤配置中移除",
    },
    S26: {
      execution_failure: null,
      resource_anomaly: "在步骤 prompt 中明确引导检索该知识库（说明应查询哪些知识、在什么条件下查询），或将确实不需要的知识库从步骤配置中移除",
    },
  };

  const entry = suggestions[scenario];
  if (!entry) return "";
  if (category && entry[category]) return entry[category];
  // 如果没有指定 category 或该 category 没有建议，返回任意非空的
  return entry.execution_failure || entry.resource_anomaly || "";
}

function _sumWasted(candidates, scenarios) {
  return candidates
    .filter(c => scenarios.includes(c.scenario))
    .reduce((sum, c) => sum + c.wasted_tokens_est, 0);
}

function _countCandidates(candidates, scenarios) {
  return candidates.filter(c => scenarios.includes(c.scenario)).length;
}

export function writeKnowledge(report, outDir) {
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, ".ai-knowledge.md");
  const parts = [
    "# Project Knowledge (auto-generated by session-doctor v0)\n",
    "> 由历史 session 诊断生成，用于避免重复探索与反复失败。\n",
  ];
  for (const b of report.knowledge_blocks) {
    parts.push(b.markdown.trimEnd() + `\n\n<!-- solves: ${b.solves.join(", ")} -->\n`);
  }
  writeFileSync(path, parts.join("\n"));
  return path;
}

export function writeAttribution(report, outDir) {
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, "attribution.json");
  writeFileSync(path, JSON.stringify(report.attribution, null, 2));
  return path;
}

function _injectKnowledge(blocks, projectRoot) {
  mkdirSync(projectRoot, { recursive: true });
  const knowledgePath = join(projectRoot, ".ai-knowledge.md");
  const parts = [
    "# Project Knowledge (auto-generated by session-doctor)\n",
    "> 由历史 session 诊断生成，用于避免重复探索与反复失败。\n\n",
  ];
  for (const b of blocks) {
    const markdown = b.markdown || "";
    const solves = b.solves || [];
    parts.push(markdown.trimEnd() + `\n\n<!-- solves: ${solves.join(", ")} -->\n`);
  }
  writeFileSync(knowledgePath, parts.join("\n"), "utf-8");

  // AGENTS.md 追加引用（幂等）
  const agentsMdPath = join(projectRoot, "AGENTS.md");
  const refLine = "> 自动生成：详见 .ai-knowledge.md\n";
  if (existsSync(agentsMdPath)) {
    const content = readFileSync(agentsMdPath, "utf-8");
    if (!content.includes(refLine.trim())) {
      appendFileSync(agentsMdPath, "\n" + refLine, "utf-8");
    }
  } else {
    writeFileSync(agentsMdPath, refLine, "utf-8");
  }
  return knowledgePath;
}
