// metrics.mjs — Session 指标计算
// 对照 Python metrics.py

const _CODE_EDIT = new Set(["Write", "Edit", "NotebookEdit"]);
const _EXPLORE_TOOLS = new Set(["Read", "Grep", "Glob", "LS"]);

function _firstEditSeq(trace) {
  for (const e of trace.events) {
    if (e.type === "tool_call" && _CODE_EDIT.has(e.tool_name)) return e.seq;
  }
  return null;
}

function _estOutTokens(e) {
  return (e.output_tokens || 0) + Math.floor((e.tool_output || "").length / 4);
}

export function compute(trace, candidates) {
  const fe = _firstEditSeq(trace);
  const pre = fe === null ? trace.events : trace.events.filter(e => e.seq < fe);

  const exploreTokens = pre.filter(e =>
    (e.type === "tool_call" && (_EXPLORE_TOOLS.has(e.tool_name) || e.tool_name === "Bash")) || e.type === "assistant"
  ).reduce((s, e) => s + _estOutTokens(e), 0);

  const turnsToFirstEdit = pre.filter(e => e.type === "tool_call").length;

  // 反复失败（S4/S5/S7）
  let rep = 0;
  for (const c of candidates) {
    if (["S4", "S5", "S7"].includes(c.scenario)) {
      rep += parseInt(c.metrics.fail_count || c.metrics.repeat || 1);
    }
  }

  const redundantReads = candidates
    .filter(c => c.scenario === "S11")
    .reduce((s, c) => s + Math.max(0, parseInt(c.metrics.count || 0) - 1), 0);

  const totalTokens = trace.total_input_tokens + trace.total_output_tokens;

  return {
    exploration_tokens: exploreTokens,
    repeated_failures: rep,
    total_tokens: totalTokens,
    total_output_tokens: trace.total_output_tokens,
    turns_to_first_edit: turnsToFirstEdit,
    redundant_reads: redundantReads,
    total_tool_calls: trace.tool_calls.length,
    wasted_tokens_est: candidates.reduce((s, c) => s + c.wasted_tokens_est, 0),
    wasted_time_est: candidates.reduce((s, c) => s + (c.wasted_time_est || 0), 0),
    candidate_count: candidates.length,
  };
}

export const CSV_FIELDS = ["session_id", "exploration_tokens", "repeated_failures", "total_tokens",
  "turns_to_first_edit", "redundant_reads", "total_tool_calls",
  "wasted_tokens_est", "candidate_count"];
