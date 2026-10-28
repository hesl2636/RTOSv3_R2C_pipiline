// analyzer.mjs — 合并分析器：每 cluster 一次 LLM 调用，同时输出判定（verdicts）+ 修复建议（fix_blocks）
// 取代 confirmer + fixer 的两阶段独立调用，减少一次 LLM 往返；判定时即拿成功命令生成 fix_prompt
// 支持多 cluster 并发分析（ANALYZE_CONCURRENCY 环境变量控制并发度，默认 3）

import { Verdict, KnowledgeBlock } from './model.mjs';
import { callModelAsync, extractJson } from './codeagent-client.mjs';
import { CONFIRM_PROMPT } from './confirmer.mjs';
import { fallbackFixPrompt } from './fixer.mjs';
import { inferScope } from './scope-rules.mjs';

/** 追加到判定 prompt 的修复建议规则（复用 FIX_PROMPT 的 fix_prompt 生成规范） */
const FIX_BLOCKS_RULES = `

## 修复建议（fix_blocks）

对判定为真的问题（is_real=true），在同一 JSON 中输出 \`fix_blocks\` 数组：可直接合并到 workflow 步骤 prompt 的知识块。

每个 fix_block 字段：
- title: 简短标题（如 "Commands"）
- markdown: ## Section 格式（## Runtimes / ## Commands / ## Build Gotchas / ## Env Vars / ## Prerequisites）
- solves: 预防的场景 id 数组（如 ["S3"]）
- attribution_type: "execution_failure" 或 "resource_anomaly"
- scope: "personal"（本机环境差异）或 "organization"（项目通用知识）
- fix_prompt: 可直接追加到 workflow 步骤 prompt 末尾的约束文本（**简洁命令式，给出最终成功命令**）
  - 核心：最终成功的命令，精炼一行，如 "- 测试命令：\\\`python -m pytest tests/\\\`（最终成功命令，直接使用，勿再试错）"
  - **命令必须精简**：去掉 cd 前缀、2>&1、| tail -n、| head 等 shell 噪音，只保留核心命令（可保留解释器绝对路径，如 C:/.../Python312/python.exe -m pytest tests）
  - **每个 fix_prompt 必须包含至少一条「最终成功命令」（带反引号的可执行命令）**：运行/构建/测试/依赖安装/lint/替代命令等；若只是解释器路径/版本说明，需再补一条最终成功命令（如 "- 运行命令：\\\`py script.py\\\`（最终成功命令，直接使用，勿再试错）"）
  - 场景类别：构建命令/测试命令/lint 命令/依赖安装命令/替代命令/配置工具链命令/运行时探测命令/解释器绝对路径/运行命令
  - **S1 运行时探测**：额外给出解释器绝对路径，如 "- 解释器绝对路径：\\\`C:/.../Python312/python.exe\\\`（Windows 下 \\\`python\\\` 是 Store stub，直接使用此绝对路径）"
  - 当前切片看不到最终结果 → 用 context_requests 调 getNextFragments 查看后续切片找到成功命令
  - 场景覆盖：S1 运行时探测/解释器路径、S2/S10/S11 关键路径、S3/S5/S7 构建测试、S4 git、S6 lint、S8 替代命令、S9/S21 依赖安装、S16 环境变量、S22/S23 配置工具链
  - 无成功命令可提取（S13/S14/S15/S18/S19/S20）→ fix_prompt 留空字符串
  - 不要写指导性文本（如"请预置..."），只写可直接合并的命令/约束
  - **S24（配置了 skill 未调用）/S25（配置了 MCP 未调用）/S26（配置了知识库未读取）**：candidate 的 metrics.items[0] 含该 skill 的摘要（skillSummary）或 MCP/知识库名称与步骤名。fix_prompt 必须是**可直接追加到该步骤 prompt 末尾的调用引导文本**，指明该步骤应调用哪个能力、在什么条件下调用、为什么需要它：
    - 结合 skillSummary 说明该 skill 的用途与本步骤任务的契合点，如 "- 本步骤必须调用 \`xxx\` skill 完成…（skill 用途：…）"
    - 若为配置冗余（任务确实不需要该能力），is_real=false 且 fix_prompt 写 "- 移除步骤中未使用的 \`xxx\` 配置，避免误导"
    - 不要编造不存在的命令；S24/S25/S26 的 fix_prompt 是调用引导而非 shell 命令

Return ONLY JSON, no fence:
{{"verdicts":[...],"fix_blocks":[{{"title":"Commands","markdown":"## Commands\\n- Build: ...","solves":["S3"],"attribution_type":"resource_anomaly","scope":"organization","fix_prompt":"- 构建命令：\\\`python -m pytest tests/\\\`（最终成功命令，直接使用，勿再试错）"}}]}}
`;

const ANALYZE_PROMPT = CONFIRM_PROMPT + FIX_BLOCKS_RULES;

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

/**
 * 生成 fix_prompt：合并策略——规则兜底（fallbackFixPrompt，可靠提取最终成功命令/解释器路径）
 * + LLM 内容，按行去重。确保所有场景的 fix_prompt 都含可合并的命令式内容
 * （最终成功命令、解释器绝对路径等），不依赖 LLM 是否主动给出。
 */
function _fixPromptFor(b, trace, facts) {
  const llm = (typeof b.fix_prompt === "string" && b.fix_prompt.trim()) ? b.fix_prompt.trim() : "";
  const fallback = fallbackFixPrompt(b.solves || [], trace, facts);
  const fbLines = fallback ? fallback.split("\n").filter(Boolean) : [];
  const llmLines = llm ? llm.split("\n").filter(Boolean) : [];
  // 按行类别去重（如"解释器绝对路径"/"运行时探测"/"替代命令"只保留一条；fallback 优先，因其可靠）
  const seenCat = new Set();
  const merged = [];
  const catOf = (l) => {
    const m = l.match(/^-\s*([^：:]+?)[：:]/);
    return m ? m[1].trim() : l.slice(0, 30);
  };
  for (const l of [...fbLines, ...llmLines]) {
    const key = catOf(l);
    if (!seenCat.has(key)) { seenCat.add(key); merged.push(l); }
  }
  return merged.join("\n") || llm || fallback;
}

/** 简单并发池：按序执行 tasks，结果按任务下标返回（保证顺序） */
async function _runPool(tasks, concurrency) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      try {
        results[i] = await tasks[i]();
      } catch (err) {
        results[i] = null;
      }
    }
  }
  const n = Math.max(1, Math.min(concurrency, tasks.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

export class Analyzer {
  constructor(model = "GLM-5.2-Auto(Volcano-MaaS)") { this.name = "codeagent"; this.model = model; }

  /**
 * 合并分析：每 cluster 一次 LLM 调用（cluster 间并发），输出判定 + 修复建议。
   * @returns {Promise<[Verdict[], KnowledgeBlock[], stats]>}
   */
  async analyze(candidates, wiki, trace, facts, retriever = null) {
    const stats = { backend: this.name, calls: 0, cost_usd: 0.0, input_tokens: 0, output_tokens: 0, multi_round_calls: 0 };

    // 按 cluster 分组（同一场景簇共享一次 prompt 与上下文）
    const byCluster = {};
    for (const c of candidates) {
      if (!byCluster[c.cluster]) byCluster[c.cluster] = [];
      byCluster[c.cluster].push(c);
    }

    const clusterEntries = Object.entries(byCluster);
    const concurrency = Math.max(1, parseInt(process.env.ANALYZE_CONCURRENCY || "3", 10) || 3);

    // 并发分析各 cluster（结果按任务下标收集，保证 verdicts 与 candidates 顺序一致）
    const results = await _runPool(
      clusterEntries.map(([cluster, cands]) => () => this._analyzeCluster(cluster, cands, wiki, trace, facts, retriever)),
      concurrency
    );

    const verdicts = [];
    const blocks = [];
    for (const r of results) {
      if (!r) continue;
      verdicts.push(...r.verdicts);
      blocks.push(...r.blocks);
      stats.calls += r.calls;
      stats.cost_usd += r.cost_usd;
      stats.input_tokens += r.input_tokens;
      stats.output_tokens += r.output_tokens;
      stats.multi_round_calls += r.multi_round_calls;
    }

    return [verdicts, blocks, stats];
  }

  /** 分析单个 cluster（多轮判定 + 修复建议），返回该 cluster 的产物与调用统计 */
  async _analyzeCluster(cluster, cands, wiki, trace, facts, retriever) {
    const verdicts = [];
    const blocks = [];
    const stats = { calls: 0, cost_usd: 0.0, input_tokens: 0, output_tokens: 0, multi_round_calls: 0 };

    // 精准召回：候选 slice_ids（主证据）+ cluster 语义检索补充
    const terms = [];
    for (const c of cands) {
      for (const v of Object.values(c.metrics)) {
        if (typeof v === "string") terms.push(v);
      }
    }
    const primIds = [];
    for (const c of cands) primIds.push(...c.slice_ids);
    const primSeen = new Set();
    const prim = [];
    for (const i of primIds) {
      if (!primSeen.has(i) && wiki.slices[i]) { prim.push(wiki.slices[i]); primSeen.add(i); }
    }
    const primIdSet = new Set(prim.map(s => s.slice_id));
    const supp = wiki.retrieve(cluster, terms, 6).filter(s => !primIdSet.has(s.slice_id));
    const slices = [...prim, ...supp];

    const candTxt = cands.map((c, i) =>
      `- [${i}] ${c.scenario}: ${c.description} | metrics=${JSON.stringify(c.metrics)}`
    ).join("\n");

    // 多轮对话：判定 + 修复（≤3 轮）
    const MAX_ROUNDS = 3;
    let round = 0;
    let contextResults = "";
    let finalParsed = null;

    while (round < MAX_ROUNDS) {
      round++;
      const prompt = ANALYZE_PROMPT
        .replace("{brief}", briefOf(trace))
        .replace("{candidates}", candTxt)
        .replace("{slices}", _renderSlices(slices))
        .replace("{context_results}", contextResults);

      const res = await callModelAsync(prompt, this.model);
      stats.calls++;
      stats.cost_usd += res.cost_usd;
      stats.input_tokens += res.input_tokens;
      stats.output_tokens += res.output_tokens;
      if (round > 1) stats.multi_round_calls++;

      // 降级：LLM 不可用 → 本 cluster 规则兜底（低置信度判定 + 跳过修复）
      if (!res.ok && (res.error.includes("401") || res.error.includes("timeout") || res.error.includes("not found"))) {
        console.error(`[analyzer] codeagent call failed (${res.error}), falling back to mock for cluster ${cluster}`);
        for (const c of cands) {
          verdicts.push(new Verdict(c.scenario, true, 0.4,
            `（模型调用失败: ${res.error}；保持低置信度）`, "", c.wasted_tokens_est, null, c.wasted_time_est || 0));
        }
        finalParsed = null;
        break;
      }

      const parsed = res.ok ? extractJson(res.text) : null;
      if (!parsed || !parsed.verdicts) {
        console.error(`[analyzer] round ${round}: failed to parse JSON`);
        finalParsed = null;
        break;
      }

      const contextRequests = parsed.context_requests || [];
      if (contextRequests.length === 0 || round === MAX_ROUNDS || !retriever) {
        finalParsed = parsed;
        break;
      }

      // 执行 AI native 工具调用（getNextFragments 等）→ 下一轮补上下文
      const toolResults = [];
      for (const req of contextRequests) {
        toolResults.push({
          tool: req.tool,
          args: req.args,
          result: this._executeToolCall(retriever, req),
        });
      }
      contextResults = "\n\n[工具调用结果]\n" + JSON.stringify(toolResults, null, 2);
    }

    // 构造 verdicts（按 index/scenario 匹配，同 confirmer）
    // 注意：同 cluster 内多个 candidate 可能同 scenario（如 S24 每个 skill 一个 candidate）。
    // gotByScenario 用 scenario 做 key 会互相覆盖，导致后一个 candidate 覆盖前一个的 verdict。
    // 修复：优先按 index 匹配；index 缺失时按 scenario 分组，同 scenario 的 verdict 按出现顺序
    // 依次分配给对应 candidate（队列消费），确保每个 candidate 拿到独立的判定。
    const gotByIndex = {};
    const gotByScenarioQueue = {}; // scenario -> Verdict[]
    if (finalParsed && finalParsed.verdicts) {
      for (const v of finalParsed.verdicts) {
        if (v.index != null) {
          gotByIndex[v.index] = v;
        } else if (v.scenario) {
          if (!gotByScenarioQueue[v.scenario]) gotByScenarioQueue[v.scenario] = [];
          gotByScenarioQueue[v.scenario].push(v);
        }
      }
    }
    cands.forEach((c, i) => {
      let v = gotByIndex[i];
      if (!v && gotByScenarioQueue[c.scenario]) {
        v = gotByScenarioQueue[c.scenario].shift() || null; // 同 scenario 按顺序消费
      }
      if (v) {
        verdicts.push(new Verdict(
          c.scenario, !!v.is_real, parseFloat(v.confidence || 0.5),
          String(v.root_cause || "").slice(0, 200),
          String(v.evidence || "").slice(0, 200),
          c.wasted_tokens_est,
          v.category || null, c.wasted_time_est || 0
        ));
      } else {
        verdicts.push(new Verdict(c.scenario, true, 0.4,
          `（模型未返回判定结果；保持低置信度）`, "", c.wasted_tokens_est, null, c.wasted_time_est || 0));
      }
    });

    // 构造 fix_blocks（同 fixer；LLM 未给 fix_prompt 时规则兜底）
    const parsedBlocks = (finalParsed && finalParsed.fix_blocks) || [];
    for (const b of parsedBlocks) {
      if (!b.markdown) continue;
      blocks.push(new KnowledgeBlock(
        b.title || "Untitled",
        b.markdown || "",
        b.solves || [],
        "model+facts",
        b.scope === "organization" || b.scope === "personal"
          ? b.scope
          : inferScope((b.solves || [])[0] || "", facts),
        typeof b.confidence === "number" ? b.confidence : 0,
        _fixPromptFor(b, trace, facts),
      ));
    }

    return { verdicts, blocks, ...stats };
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

function briefOf(trace) {
  let task = "";
  for (const e of (trace?.events || [])) {
    if (e.type === "user" && e.text) { task = e.text; break; }
  }
  return `${trace?.tool || 'agent'} session, model=${trace?.model || ''}, cwd=${trace?.cwd || ''}\nTask: ${task.slice(0, 300)}`;
}
