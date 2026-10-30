// confirmer.mjs — 模型确认：过滤脚本候选里的误报 + 定根因
// 对照 Python confirmer.py

import { Verdict } from './model.mjs';
import { callModel, callModelAsync, extractJson } from './codeagent-client.mjs';

export const CONFIRM_PROMPT = `你正在审计一个 AI 编码 session。脚本检测器标记了以下候选问题。
对每个候选，判断它是否是一个【可预防的问题】（通过项目文档/配置/工作流编排可以避免，让后续 session 跳过）。

**重要：所有文本字段必须使用中文描述**，包括 evidence、root_cause 等。

**重要：你必须为每一个候选都返回一个判定，不能遗漏任何候选。**

## 判断标准

**is_real=true（真实问题）**：
- 稳定事实可预定义（路径/版本/结构/命令，这些不变）
- 无进展的重试循环（重复失败但不改变策略）
- 可避免的错误（通过项目文档/配置/工作流编排可以预防）

**is_real=false（误报）**：
- 任务本身就需要这样做（如任务明确要求"探索环境"）
- 健康的迭代进展（尝试不同方法但有进展）

confidence = P(真实问题), 0..1
evidence = 最短定位证据（中文）：slice id + 你依赖的命令/错误/路径子串（如 "slice 4: cargo --version 重跑"）。只引用证据切片中的内容。
root_cause = 一行（中文）：用通俗易懂的语言描述问题原因和预防方法。不要用"项目笔记应记录"这种晦涩表述，直接说"请检查..."或"在项目 markdown 中预置..."或"在工作流中编排..."。
category = "execution_failure"（执行失败类）或 "resource_anomaly"（资源消耗异常类）—— **每个候选只能返回一个 category，不能同时归入两类**

## 分类定义（两个维度）

**执行失败类（execution_failure）**：操作本身返回了错误或未能完成，如命令不存在、skill 调用报错、MCP 工具报错、构建失败、依赖缺失、Edit 匹配失败等。核心特征是"某个操作失败了或始终没成功"。

**资源消耗异常类（resource_anomaly）**：操作可能成功了，但消耗了不必要的时间/token，如重复读文件、空搜索连环、环境变量探测、命令试错最终成功等。核心特征是"操作没报错（或最终成功了），但浪费了资源"。

**关键规则**：对于既可能失败又可能浪费的场景，你必须根据证据判断该候选属于哪个单一分类：
- 如果证据显示操作最终失败了/始终没成功 → execution_failure
- 如果证据显示操作最终成功了但过程浪费 → resource_anomaly
- 不要把同一个候选同时归入两个分类

## S1-S20 场景细化分类标准

对每个场景，根据证据判断它属于"操作失败"还是"操作成功但浪费"：

**S1 运行时版本/路径探测**：
- 操作失败：探测命令报错（如 which 返回非零、版本命令不存在）→ execution_failure
- 操作成功但浪费：探测命令成功执行但反复探测同一运行时 → resource_anomaly（默认）

**S2 项目结构探索过度**：
- 操作成功但浪费：大量探索操作成功但无产出 → resource_anomaly（默认）

**S3 构建/测试/lint 命令试错**：
- 操作失败：所有命令尝试都失败了，始终没找到正确命令 → execution_failure
- 操作成功但浪费：反复尝试不同写法后最终成功 → resource_anomaly

**S4 Git 操作试错**：
- 操作失败：git 命令始终报错未解决 → execution_failure
- 操作成功但浪费：git 命令反复尝试后最终成功 → resource_anomaly

**S5 构建反复失败**：
- 操作失败：构建始终失败未解决 → execution_failure
- 操作成功但浪费：构建反复失败后最终成功 → resource_anomaly

**S6 代码格式化问题**：
- 操作失败：格式化命令始终失败 → execution_failure
- 操作成功但浪费：格式化反复尝试后最终成功 → resource_anomaly

**S7 测试环境配置问题**：
- 操作失败：测试环境始终配不通 → execution_failure
- 操作成功但浪费：环境反复配置后最终成功 → resource_anomaly

**S8 调用不存在的命令**：
- 操作失败：命令不存在，操作直接失败 → execution_failure（默认）

**S9 环境变量配置错误**：
- 操作失败：环境变量错误导致操作失败 → execution_failure（默认）

**S10 路径别名不理解**：
- 操作失败：路径别名导致导入/访问失败 → execution_failure（默认）

**S11 重复读同文件**：
- 操作成功但浪费：读操作成功但重复 → resource_anomaly（默认）

**S12 文件搜索关键词盲猜**：
- 操作成功但浪费：连续空搜索后最终找到 → resource_anomaly（默认）

**S13 Edit 前未 Read**：
- 操作失败：Edit 报错"String to replace not found"且未重试 → execution_failure
- 操作成功但浪费：Edit 首次失败后重试成功 → resource_anomaly

**S14 用 bash 代替专用工具**：
- 操作失败：bash 命令执行失败 → execution_failure
- 操作成功但浪费：bash 成功但本应用专用工具（更高效）→ resource_anomaly

**S15 代码修改后未验证**：
- 操作失败：修改后未验证导致后续操作失败 → execution_failure
- 操作成功但浪费：修改成功但未验证，后续返工验证 → resource_anomaly

**S16 环境变量探测**：
- 操作成功但浪费：探测成功但反复 → resource_anomaly（默认）

**S17 缺失资源未检查**：
- 操作失败：资源缺失导致操作始终失败 → execution_failure
- 操作成功但浪费：缺失资源后反复重试最终找到替代方案 → resource_anomaly

**S18 未使用的 skill**：
- 操作成功但浪费：skill 加载但未用 → resource_anomaly（默认）

**S19 Skill 调用后报错**：
- 操作失败：skill 调用报错 → execution_failure（默认）

**S20 MCP 工具调用后报错**：
- 操作失败：MCP 调用报错 → execution_failure（默认）

**注意**：不要因为"这是环境问题"就判定 is_real=false。如果项目文档提前告知了环境信息（如"MCP wiki 服务不可用"、"需要先 npm install"、"使用 py 而非 python"），agent 就不会犯这些错误。所以这些错误是**可以通过项目文档预防的**。

**唯一例外**：如果任务明确要求 agent 做探索/调试（如"探索项目环境"），那么相关的探测命令是必要的，此时 is_real=false。

## 必须为每个候选返回判定

你必须为 Candidates 列表中的**每一个**候选都返回一个判定。如果候选列表有 N 个候选，verdicts 数组必须有 N 个元素。不要遗漏任何候选。每个 verdict 必须包含与候选列表中相同的 scenario 和 index 字段，以便准确匹配。

## 可用工具（只读，用于多轮获取更多上下文）

如果你认为当前证据不足以做出准确判断，可以在返回的 JSON 中包含 \`context_requests\` 字段来请求更多上下文。系统会执行这些请求并在下一轮对话中返回结果。**你可以多次请求上下文（最多 3 轮），直到你有足够证据做出准确判断。**

**可用工具：**
1. \`getNextFragments(slice_id, count)\`获取指定切片之后的 N 个片段（用于查看某操作之后发生了什么）
2. \`getPreviousFragments(slice_id, count)\`获取指定切片之前的 N 个片段（用于查看某操作之前发生了什么）
3. \`getFragmentById(slice_id)\`获取指定 ID 的片段完整内容
4. \`getSessionOverview()\`获取 session 概览（所有片段的索引和元数据）

**权限限制：**
- 这些工具只能用于获取上下文信息，不能用于修改或删除任何内容
- 每轮最多调用 3 个工具，最多 3 轮对话，避免无限循环
- 如果 3 轮对话后仍无法确定，请基于现有证据给出最佳判断

**何时必须请求更多上下文（重要！）：**

对于跨类场景（S3/S4/S5/S6/S7/S13/S14/S15/S17），你必须确认操作最终是否成功，才能判断分类：
- 如果候选标记了 S3/S4/S5/S6/S7（命令试错），但你看到的证据切片中没有最终结果 → **必须调用 getNextFragments** 查看后续切片，确认操作最终成功还是失败
- 如果候选标记了 S13（Edit 前未 Read），但你看不到 Edit 是否重试成功 → **必须调用 getNextFragments** 确认重试结果
- 如果候选标记了 S15（代码修改后未验证），但你看到的证据切片中确实没有验证操作 → **必须调用 getNextFragments** 查看后续切片，确认验证是否真的没发生
- 如果候选标记了 S14（用 bash 代替专用工具），但你看不到 bash 是否成功 → **必须调用 getFragmentById** 获取完整片段确认
- 如果证据切片不完整、被截断、或你看不到 session 的完整流程 → **必须调用 getSessionOverview** 获取全局视图
- 如果你不确定某个操作是否发生或最终结果 → **先请求更多上下文，再下结论**
- **不要在证据不足时猜测分类**，特别是"操作最终成功还是失败"这个关键判断，必须用上下文工具确认

## S24/S25/S26 专属判定（配置了 skill/mcp/知识库但未使用）

检测器已通过工作流配置 vs 实际调用对比，**确定**了"步骤配置了 X（skill/mcp/知识库）但整个会话未调用/未检索"——这是客观事实，**不要判断"是否发生了"**。你的任务是分析**为什么没有调用**，并判断是否值得修复。

**重要：S24/S25/S26 的判定证据已全部在候选 metrics 中**（步骤 prompt + skill 摘要 + 失败日志），**不要返回 context_requests**，在**第一轮直接给出最终 verdicts 和 fix_blocks**——这些场景与 transcript 切片无关，请求更多上下文只会浪费时间。

每个候选的 metrics 中包含：
- items：每项含 step（步骤名）、hasCalls（是否有过相关调用尝试，通常 false）、failureLogs（若尝试过但失败，含失败日志；空数组 = 无失败调用）、skillSummary（skill 摘要，仅 S24）
- stepPrompts：{步骤名: 该步骤的完整 prompt 文本}（内嵌 prompt 或已从 tasks/<stepId>.md 读取；若不可见会标注）

**分析"为什么没调用"，依次检查：**
1. **步骤 prompt 是否明确要求使用 X？** 若 prompt 只列出了可用项（如"该步骤可用 skills: [...]"）但**没有强调必须使用/给出调用指引** → 模型视为可选而跳过 → 根因是"prompt 引导不足"
2. **任务描述是否真的需要 X？** 若任务与 X 的功能无关（如配置了检索知识库的 skill 但任务是写测试，与知识库检索无关）→ **配置与任务不匹配**（配置冗余），修复方向是调整/移除配置而非强制调用
3. **是否有失败日志（hasCalls=true 且有 failureLogs）？** 若尝试过但报错 → 根因是"工具/依赖不可用"，修复方向是修复工具而非强制调用
4. **配置的 X 与任务描述不符？** 如步骤配置了某 skill 但该 skill 的能力（从名称/步骤上下文推断）与任务不匹配 → 配置选型错误

**is_real 判定：**
- is_real=true：该步骤任务确实需要 X 的能力，且 prompt 未有效引导使用（应强化 prompt 或修复工具）
- is_real=false：任务本身不需要 X（配置冗余），或 X 已被其他步骤/方式使用（配置错位）

**root_cause 必须给出"为什么没用"的具体结论**，引用步骤 prompt 或失败日志中的证据（如："步骤 prompt 仅列出可用 skills 未强调必须使用，模型跳过；任务描述与 aceharness-rag 检索无关"）。

**重要：items 数组中每个步骤的能力未使用都是独立的，必须分别给出 root_cause**——不要汇总成一条。例如 items 含 3 个步骤的 skill 未使用，必须输出 3 个 verdict（index 0/1/2 分别对应），每个 root_cause 只描述该步骤为什么没用该能力。verdicts 数组长度必须等于 candidates 的 items 总数。

**fix_prompt（solves 填 S24/S25/S26）**：可直接追加到该步骤 prompt 末尾的强化指令——明确要求使用（如"- 必须先调用 aceharness-rag 检索知识库 '<检索关键词>' 再回答"），或建议移除/更换配置（如"- 该步骤任务不需要 openviking 知识库检索，请移除步骤的 RAG 配置"）。

**返回格式（第一轮）：**
{{
  "verdicts": [
    {{"index": 0, "scenario":"S1","is_real":true,"confidence":0.9,"category":"resource_anomaly","evidence":"slice N: ...","root_cause":"..."}}
  ],
  "context_requests": [
    {{"tool": "getNextFragments", "args": {{"slice_id": "xxx-sl0003", "count": 2}}}},
    {{"tool": "getSessionOverview", "args": {{}}}}
  ]
}}

如果证据已经完整覆盖了你判断所需的所有信息，可以省略 \`context_requests\` 字段或返回空数组。

**返回格式（后续轮次，带上下文结果）：**
系统会在 prompt 中注入工具调用结果，格式如下：
\`\`\`
[工具调用结果]
getNextFragments(xxx-sl0003, 2) = [
  {{slice_id: "xxx-sl0004", content: "..."}},
  {{slice_id: "xxx-sl0005", content: "..."}}
]
\`\`\`

你需要基于这些新信息更新你的判断，返回最终的 verdicts（此时不要再包含 context_requests，除非仍需更多上下文且未达 3 轮上限）。

Task/Project: {brief}

Candidates:
{candidates}

Evidence slices (flagged events + context; cite these ids):
{slices}

{context_results}
`;

function _renderSlices(slices, budgetChars = 3500) {
  const out = [];
  let used = 0;
  for (const s of slices) {
    const block = `### slice ${s.slice_id} [${s.workflow_stage}]\n${s.renderCompact()}`;
    if (used + block.length > budgetChars) break;
    out.push(block);
    used += block.length;
  }
  return out.join("\n\n") || "(no slices)";
}

export class MockConfirmer {
  constructor() { this.name = "mock"; }

  confirm(candidates, wiki, trace) {
    const verdicts = candidates.map(c =>
      new Verdict(c.scenario, true, 0.9, `[mock] ${c.description}`, "", c.wasted_tokens_est, null, c.wasted_time_est || 0)
    );
    return [verdicts, { backend: "mock", calls: 0, cost_usd: 0.0 }];
  }
}

export class CodeAgentConfirmer {
  constructor(model = "GLM-5.2-Auto(Volcano-MaaS)") { this.name = "codeagent"; this.model = model; }

  async confirm(candidates, wiki, trace, retriever = null) {
    let task = "";
    for (const e of trace.events) {
      if (e.type === "user" && e.text) { task = e.text; break; }
    }
    const brief = `${trace.tool} session, model=${trace.model}, cwd=${trace.cwd}\nTask: ${task.slice(0, 300)}`;

    // 按 cluster 分组
    const byCluster = {};
    for (const c of candidates) {
      if (!byCluster[c.cluster]) byCluster[c.cluster] = [];
      byCluster[c.cluster].push(c);
    }

    const verdicts = [];
    const stats = { backend: this.name, calls: 0, cost_usd: 0.0, input_tokens: 0, output_tokens: 0, multi_round_calls: 0 };

    // 并发分析各 cluster（与 analyzer 一致：ANALYZE_CONCURRENCY 默认 3，结果按序合并）
    const _runPool = async (tasks, concurrency) => {
      const results = new Array(tasks.length);
      let next = 0;
      async function worker() {
        while (next < tasks.length) {
          const i = next++;
          try { results[i] = await tasks[i](); } catch { results[i] = null; }
        }
      }
      await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length)) }, () => worker()));
      return results;
    };
    const concurrency = Math.max(1, parseInt(process.env.ANALYZE_CONCURRENCY || "3", 10) || 3);
    const results = await _runPool(
      Object.entries(byCluster).map(([cluster, cands]) => () => this._confirmCluster(cluster, cands, wiki, trace, brief, retriever)),
      concurrency
    );
    for (const r of results) {
      if (!r) continue;
      verdicts.push(...r.verdicts);
      stats.calls += r.calls;
      stats.cost_usd += r.cost_usd;
      stats.input_tokens += r.input_tokens;
      stats.output_tokens += r.output_tokens;
      stats.multi_round_calls += r.multi_round_calls;
    }
    return [verdicts, stats];
  }

  /** 判定单个 cluster（多轮），返回 { verdicts, calls, cost_usd, input_tokens, output_tokens, multi_round_calls } */
  async _confirmCluster(cluster, cands, wiki, trace, brief, retriever) {
    const verdicts = [];
    const stats = { calls: 0, cost_usd: 0.0, input_tokens: 0, output_tokens: 0, multi_round_calls: 0 };
      const terms = [];
      for (const c of cands) {
        for (const v of Object.values(c.metrics)) {
          if (typeof v === "string") terms.push(v);
        }
      }
      // 主证据
      const primIds = [];
      for (const c of cands) primIds.push(...c.slice_ids);
      const primSeen = new Set();
      const prim = [];
      for (const i of primIds) {
        if (!primSeen.has(i) && wiki.slices[i]) { prim.push(wiki.slices[i]); primSeen.add(i); }
      }
      // 补充证据
      const primIdSet = new Set(prim.map(s => s.slice_id));
      const supp = wiki.retrieve(cluster, terms, 6).filter(s => !primIdSet.has(s.slice_id));
      const slices = [...prim, ...supp];

      const candTxt = cands.map((c, i) =>
        `- [${i}] ${c.scenario}: ${c.description} | metrics=${JSON.stringify(c.metrics)}`
      ).join("\n");

      // 多轮对话：最多 3 轮
      const MAX_ROUNDS = 3;
      let round = 0;
      let contextResults = "";
      let finalParsed = null;

      while (round < MAX_ROUNDS) {
        round++;
        const prompt = CONFIRM_PROMPT
          .replace("{brief}", brief)
          .replace("{candidates}", candTxt)
          .replace("{slices}", _renderSlices(slices))
          .replace("{context_results}", contextResults);

        const res = await callModelAsync(prompt, this.model);
        stats.calls++;
        stats.cost_usd += res.cost_usd;
        stats.input_tokens += res.input_tokens;
        stats.output_tokens += res.output_tokens;
        if (round > 1) stats.multi_round_calls++;

        // 调试：打印模型调用的详细信息
        if (process.env.DEBUG) {
          console.log(`[confirmer] round ${round}: prompt length=${prompt.length}, ok=${res.ok}, error=${JSON.stringify(res.error)}, text length=${res.text?.length || 0}, input_tokens=${res.input_tokens}, output_tokens=${res.output_tokens}`);
          if (res.text) {
            console.log(`[confirmer] round ${round} model output (first 300):`, res.text.slice(0, 300));
          }
          if (!res.ok) {
            console.error(`[confirmer] round ${round} model call FAILED: error=${res.error}`);
          }
        }

        // fallback: codeagent 不可用时降级到 mock 逻辑
        if (!res.ok && (res.error.includes("401") || res.error.includes("timeout") || res.error.includes("not found"))) {
          console.error(`[confirmer] codeagent call failed (${res.error}), falling back to mock`);
          for (const c of cands) {
            verdicts.push(new Verdict(c.scenario, true, 0.4,
              `（模型调用失败: ${res.error}；保持低置信度）`, "", c.wasted_tokens_est, null, c.wasted_time_est || 0));
          }
          finalParsed = null;
          break;
        }

        const parsed = res.ok ? extractJson(res.text) : null;
        if (!parsed || !parsed.verdicts) {
          console.error(`[confirmer] round ${round}: failed to parse JSON`);
          finalParsed = null;
          break;
        }

        // 检查是否需要更多上下文
        const contextRequests = parsed.context_requests || [];
        if (contextRequests.length === 0 || round === MAX_ROUNDS || !retriever) {
          // 不需要更多上下文，或已达到最大轮数，使用当前结果
          finalParsed = parsed;
          break;
        }

        // 执行工具调用
        console.log(`[confirmer] round ${round}: executing ${contextRequests.length} context requests`);
        const toolResults = [];
       for (const req of contextRequests) {
          const result = this._executeToolCall(retriever, req);
          toolResults.push({
            tool: req.tool,
            args: req.args,
            result: result
          });
        }

        // 构建下一轮的上下文结果
        contextResults = "\n\n[工具调用结果]\n" + JSON.stringify(toolResults, null, 2);
      }

      // 提取 verdicts — 使用 index 匹配，避免同 scenario 多候选碰撞
      // 同 scenario 多个候选时（如 S24 每 skill 一个），scenario 做 key 会互相覆盖。
      // 修复：优先 index；index 缺失时同 scenario verdict 按队列顺序消费，逐个分配。
      const gotByIndex = {};
      const gotByScenarioQueue = {};
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
          v = gotByScenarioQueue[c.scenario].shift() || null;
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
            "（模型未返回判定结果；保持低置信度）", "", c.wasted_tokens_est, null, c.wasted_time_est || 0));
        }
      });

    return { verdicts, ...stats };
  }

  // 执行工具调用（只读）
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

export function getConfirmer(backend, model = null) {
  if (backend === "mock") return new MockConfirmer();
  return model ? new CodeAgentConfirmer(model) : new CodeAgentConfirmer();
}
