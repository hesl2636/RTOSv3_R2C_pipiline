// adapter.mjs — CodeAgent/Claude Code transcript(.jsonl) → SessionTrace
// 对照 Python adapter.py

import { readFileSync } from 'node:fs';
import { SessionTrace, SessionEvent } from './model.mjs';

const _EXIT_RE = /^Exit code (\d+)/;

function _contentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const c of content) {
      if (c && typeof c === "object") {
        if (c.type === "text") parts.push(c.text || "");
        else if ("text" in c) parts.push(String(c.text));
      } else if (typeof c === "string") {
        parts.push(c);
      }
    }
    return parts.join("\n");
  }
  return content != null ? String(content) : "";
}

function _filePathsFromInput(name, inp) {
  if (!inp) return [];
  for (const k of ["file_path", "path", "notebook_path"]) {
    if (inp[k]) return [inp[k]];
  }
  return [];
}

export function loadTrace(jsonlPath) {
  const raw = [];
  const text = readFileSync(jsonlPath, "utf-8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      raw.push(JSON.parse(trimmed));
    } catch {
      continue;
    }
  }

  let sessionId = "", cwd = "", gitBranch = "", model = "";
  let started = "", ended = "";
  const events = [];
  let seq = 0;
  const pendingTools = {};  // tool_use_id → SessionEvent
  const skillsAvailable = [];
  const skillsUsed = [];

  const SKILL_NAME_RE = /^-\s+(\S+):/gm;

  for (const o of raw) {
    const t = o.type;
    const ts = o.timestamp || "";
    if (!sessionId && o.sessionId) sessionId = o.sessionId;
    if (!cwd && o.cwd) cwd = o.cwd;
    if (!gitBranch && o.gitBranch) gitBranch = o.gitBranch;
    if (ts) {
      if (!started) started = ts;
      ended = ts;
    }

    const msg = (o.message && typeof o.message === "object") ? o.message : null;

    if (t === "assistant" && msg) {
      if (!model && msg.model) {
        model = typeof msg.model === "string" ? msg.model : (msg.model.modelID || "");
      }
      const usage = msg.usage || {};
      const inTok = parseInt(usage.input_tokens || 0) || 0;
      const outTok = parseInt(usage.output_tokens || 0) || 0;
      let usageAttached = false;
      for (const c of (msg.content || [])) {
        if (!c || typeof c !== "object") continue;
        if (c.type === "tool_use") {
          const ev = new SessionEvent({
            seq, ts, type: "tool_call", role: "assistant",
            tool_name: c.name, tool_input: c.input || {},
            tool_use_id: c.id,
            input_tokens: !usageAttached ? inTok : 0,
            output_tokens: !usageAttached ? outTok : 0,
            file_paths: _filePathsFromInput(c.name, c.input || {}),
          });
          usageAttached = true;
          events.push(ev);
          if (ev.tool_use_id) pendingTools[ev.tool_use_id] = ev;
          seq++;
        } else if (c.type === "text") {
          const txt = c.text || "";
          if (txt.trim()) {
            events.push(new SessionEvent({
              seq, ts, type: "assistant", role: "assistant", text: txt,
              input_tokens: !usageAttached ? inTok : 0,
              output_tokens: !usageAttached ? outTok : 0,
            }));
            usageAttached = true;
            seq++;
          }
        }
      }
      // usage 未被任何 block 认领（纯 thinking 等）
      if (!usageAttached && (inTok || outTok)) {
        events.push(new SessionEvent({
          seq, ts, type: "assistant", role: "assistant",
          input_tokens: inTok, output_tokens: outTok,
        }));
        seq++;
      }

    } else if (t === "attachment") {
      const att = (o.attachment && typeof o.attachment === "object") ? o.attachment : null;
      if (att && att.type === "skill_listing") {
        const listing = att.content || "";
        let m;
        while ((m = SKILL_NAME_RE.exec(listing)) !== null) {
          const name = m[1].trim();
          if (name && !skillsAvailable.includes(name)) skillsAvailable.push(name);
        }
      }

    } else if (t === "user" && msg) {
      const content = msg.content;
      let handledResult = false;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c && typeof c === "object" && c.type === "tool_result") {
            handledResult = true;
            const tid = c.tool_use_id;
            const out = _contentToText(c.content);
            const isErr = !!c.is_error;
            const ev = pendingTools[tid];
            if (ev) {
              ev.tool_output = out;
              ev.is_error = isErr;
              // 保存 tool_result 完成时刻（user 消息的 timestamp），
              // 供 _estTime 计算真实端到端耗时（发起 → 完成），
              // 避免并发执行时只算发起时刻导致严重低估
              if (ts) ev.resultTs = ts;
              if (ev.tool_name === "Bash") {
                const m = _EXIT_RE.exec(out || "");
                if (m) {
                  ev.exit_code = parseInt(m[1]);
                } else {
                  ev.exit_code = (!isErr) ? 0 : 1;
                }
              }
            }
          }
        }
      }
      if (!handledResult) {
        const txt = _contentToText(content);
        if (txt.trim()) {
          events.push(new SessionEvent({ seq, ts, type: "user", role: "user", text: txt }));
          seq++;
        }
      }
    }
  }

  // 收集 Skill tool 实际调用
  for (const ev of events) {
    if (ev.type === "tool_call" && ev.tool_name === "Skill") {
      const skillName = (ev.tool_input || {}).skill || "";
      if (skillName && !skillsUsed.includes(skillName)) skillsUsed.push(skillName);
    }
  }

  return new SessionTrace({
    session_id: sessionId, model, cwd, git_branch: gitBranch,
    started_at: started, ended_at: ended, events,
    total_input_tokens: events.reduce((s, e) => s + e.input_tokens, 0),
    total_output_tokens: events.reduce((s, e) => s + e.output_tokens, 0),
    skills_available: skillsAvailable,
    skills_used: skillsUsed,
  });
}
