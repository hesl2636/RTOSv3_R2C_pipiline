// slicer.mjs — 切片 + 分类到 cluster
// 对照 Python slicer.py

import { SessionSlice } from './model.mjs';

const _SEARCH_TOOLS = new Set(["Grep", "Glob", "LS"]);
const _FILE_TOOLS = new Set(["Read", "Write", "Edit", "NotebookEdit"]);
const _CODE_EDIT = new Set(["Write", "Edit", "NotebookEdit"]);

const _PROBE_RE = /\b(which|whereis|type)\b|--version|(^|\s)-v($|\s)|\bversion\b/i;
const _BUILD_RE = /\b(build|compile|make|cargo build|npm run build|tsc|go build|mvn|gradle)\b/i;
const _TEST_RE = /\b(test|pytest|jest|cargo test|go test|npm test|vitest)\b/i;
const _LINT_RE = /\b(lint|eslint|clippy|ruff|flake8|prettier|fmt|rustfmt|black|gofmt)\b/i;
const _GIT_RE = /\bgit\b/i;

function _callType(e) {
  if (e.type !== "tool_call") return "other";
  const n = e.tool_name || "";
  if (n === "Bash") {
    const c = e.command;
    if (_TEST_RE.test(c)) return "verify";
    if (_BUILD_RE.test(c) || _LINT_RE.test(c)) return "verify";
    return "cli";
  }
  if (_SEARCH_TOOLS.has(n)) return "search";
  if (_CODE_EDIT.has(n)) return "code_edit";
  if (n === "Read") return "file_op";
  return "other";
}

export function sliceSession(trace) {
  const slices = [];
  let cur = [];
  let lastCt = null;

  function flush() {
    if (cur.length > 0) {
      slices.push(_buildSlice(trace.session_id, cur, slices.length));
      cur = [];
    }
  }

  for (const e of trace.events) {
    const ct = _callType(e);
    const boundary =
      (e.type === "tool_call" && lastCt !== null && ct !== lastCt) ||
      e.is_error ||
      e.type === "user";
    if (boundary) flush();
    cur.push(e);
    if (e.type === "tool_call") lastCt = ct;
  }
  flush();

  const total = slices.length;
  for (let i = 0; i < total; i++) {
    _classify(slices[i], i, total);
  }
  return slices;
}

function _buildSlice(sessionId, events, idx) {
  const toolCalls = events.filter(e => e.type === "tool_call");
  const filesSet = new Set();
  for (const e of events) {
    for (const p of (e.file_paths || [])) filesSet.add(p);
  }
  const files = [...filesSet].sort();
  const s = new SessionSlice({
    slice_id: `${(sessionId || "").slice(0, 8)}-sl${String(idx).padStart(4, "0")}`,
    session_id: sessionId,
    start_seq: events[0].seq,
    end_seq: events[events.length - 1].seq,
    events,
    has_error: events.some(e => e.is_error),
    produced_code: toolCalls.some(e => _CODE_EDIT.has(e.tool_name)),
    token_cost: events.reduce((s, e) => s + e.output_tokens + Math.floor((e.tool_output || "").length / 4), 0),
    files_touched: files,
  });
  const cts = toolCalls.map(e => _callType(e));
  if (cts.length > 0) {
    // 众数
    const counts = {};
    for (const ct of cts) counts[ct] = (counts[ct] || 0) + 1;
    s.call_type = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  } else {
    s.call_type = "other";
  }
  return s;
}

function _classify(s, position, total) {
  const ev = s.events;
  const cmds = ev.filter(e => e.tool_name === "Bash").map(e => e.command).join(" ");
  const cats = new Set();
  // C1 环境/结构重复探索
  if (_PROBE_RE.test(cmds) || s.call_type === "search") cats.add("C1");
  if ((s.call_type === "search" || s.call_type === "file_op") && !s.produced_code && position < Math.max(1, Math.floor(total / 5))) {
    cats.add("C1");
  }
  // C2 反复失败
  if (ev.some(e => e.tool_name === "Bash" && e.is_error)) cats.add("C2");
  if (_LINT_RE.test(cmds)) cats.add("C2");
  // C3 硬错误
  if (ev.some(e => e.is_error)) cats.add("C3");
  // C4 文件操作低效
  if (ev.some(e => ["Read", "Grep", "Glob"].includes(e.tool_name))) cats.add("C4");
  // 工作流阶段
  if (s.produced_code) s.workflow_stage = "code";
  else if (s.call_type === "search") s.workflow_stage = "search";
  else if (s.call_type === "verify") s.workflow_stage = "verify";
  else if (position < Math.max(1, Math.floor(total / 5))) s.workflow_stage = "understand";
  else s.workflow_stage = "plan";
  s.clusters = [...cats].sort();
  if (s.clusters.length === 0) s.clusters = ["misc"];
}
