// model.mjs — 数据结构（对照 Python model.py）
// 所有类刻意保持扁平、可 JSON 序列化。

export class SessionEvent {
  constructor({ seq, ts, type, role = "", tool_name = null, tool_input = {},
                tool_output = null, is_error = false, exit_code = null,
                input_tokens = 0, output_tokens = 0, text = "",
                tool_use_id = null, file_paths = [] }) {
    this.seq = seq;
    this.ts = ts;
    this.type = type;
    this.role = role;
    this.tool_name = tool_name;
    this.tool_input = tool_input;
    this.tool_output = tool_output;
    this.is_error = is_error;
    this.exit_code = exit_code;
    this.input_tokens = input_tokens;
    this.output_tokens = output_tokens;
    this.text = text;
    this.tool_use_id = tool_use_id;
    this.file_paths = file_paths;
  }

  get command() {
    return this.tool_input?.command || "";
  }

  toDict() {
    return {
      seq: this.seq, ts: this.ts, type: this.type, role: this.role,
      tool_name: this.tool_name, tool_input: this.tool_input,
      tool_output: this.tool_output, is_error: this.is_error,
      exit_code: this.exit_code, input_tokens: this.input_tokens,
      output_tokens: this.output_tokens, text: this.text,
      tool_use_id: this.tool_use_id, file_paths: this.file_paths,
    };
  }
}

export class SessionTrace {
  constructor({ session_id, tool = "codeagent", model = "", cwd = "", git_branch = "",
                started_at = "", ended_at = "", events = [],
                total_input_tokens = 0, total_output_tokens = 0,
                skills_available = [], skills_used = [] }) {
    Object.assign(this, { session_id, tool, model, cwd, git_branch,
      started_at, ended_at, events, total_input_tokens, total_output_tokens,
      skills_available, skills_used });
  }

  get tool_calls() {
    return this.events.filter(e => e.type === "tool_call");
  }

  bashEvents() {
    return this.events.filter(e => e.type === "tool_call" && e.tool_name === "Bash");
  }

  byTool(name) {
    return this.events.filter(e => e.type === "tool_call" && e.tool_name === name);
  }
}

export class SessionSlice {
  constructor({ slice_id, session_id, start_seq, end_seq, events = [],
                clusters = [], call_type = "", workflow_stage = "",
                has_error = false, produced_code = false, token_cost = 0,
                files_touched = [] }) {
    Object.assign(this, { slice_id, session_id, start_seq, end_seq, events,
      clusters, call_type, workflow_stage, has_error, produced_code,
      token_cost, files_touched });
  }

  renderCompact(maxOut = 400) {
    const lines = [];
    for (const e of this.events) {
      if (e.type === "tool_call") {
        const inp = e.command || _short(e.tool_input, 120);
        lines.push(`[${e.seq}] ${e.tool_name}: ${inp}`);
        if (e.tool_output) {
          const out = e.tool_output;
          if (e.is_error || out.length <= maxOut) {
            lines.push(`     -> ${e.is_error ? "ERR " : ""}${out.slice(0, maxOut)}`);
          } else {
            lines.push(`     -> (${out.length} chars, truncated) ${out.slice(0, 120)}`);
          }
        }
      } else if (e.type === "user" && e.text) {
        lines.push(`[${e.seq}] USER: ${e.text.slice(0, 160)}`);
      }
    }
    return lines.join("\n");
  }
}

export class Candidate {
  constructor(scenario, cluster, description, metrics = {}, slice_ids = [], wasted_tokens_est = 0, wasted_time_est = 0) {
    this.scenario = scenario;
    this.cluster = cluster;
    this.description = description;
    this.metrics = metrics;
    this.slice_ids = slice_ids;
    this.wasted_tokens_est = wasted_tokens_est;
    this.wasted_time_est = wasted_time_est;
  }

  toDict() {
    return { scenario: this.scenario, cluster: this.cluster, description: this.description,
             metrics: this.metrics, slice_ids: this.slice_ids, wasted_tokens_est: this.wasted_tokens_est,
             wasted_time_est: this.wasted_time_est };
  }
}

export class Verdict {
  constructor(scenario, is_real, confidence, root_cause = "", evidence = "", wasted_tokens_est = 0, category = null, wasted_time_est = 0) {
    this.scenario = scenario;
    this.is_real = is_real;
    this.confidence = confidence;
    this.root_cause = root_cause;
    this.evidence = evidence;
    this.wasted_tokens_est = wasted_tokens_est;
    this.category = category;
    this.wasted_time_est = wasted_time_est;
  }

  toDict() {
    return { scenario: this.scenario, is_real: this.is_real, confidence: this.confidence,
             root_cause: this.root_cause, evidence: this.evidence, wasted_tokens_est: this.wasted_tokens_est,
             category: this.category, wasted_time_est: this.wasted_time_est };
  }
}

export class KnowledgeBlock {
  constructor(title, markdown, solves = [], source = "", scope = "personal", confidence = 0, fixPrompt = "") {
    this.title = title;
    this.markdown = markdown;
    this.solves = solves;
    this.source = source;
    this.scope = scope;
    this.confidence = confidence;
    this.fixPrompt = fixPrompt;
  }

  toDict() {
    return {
      title: this.title, markdown: this.markdown, solves: this.solves, source: this.source,
      scope: this.scope, confidence: this.confidence, fix_prompt: this.fixPrompt,
    };
  }
}

function _short(obj, n) {
  const s = String(obj);
  return s.length <= n ? s : s.slice(0, n) + "…";
}
