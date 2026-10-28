/**
 * build-manifest.mjs — 构建 harness 组件清单 (manifest)
 *
 * manifest schema: harness.session-upload.v1
 * 数据来源: state.json, workflow.yaml, plugin.json, hooks/hooks.json,
 *           codeagent-extension.json, skills/ 目录
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";

export function buildManifest(pluginRoot, projectRoot, runDir, state, sessions) {
  // ── plugin 信息 ──────────────────────────────
  let plugin = {};
  for (const p of [join(pluginRoot, "plugin.json"), join(pluginRoot, ".claude-plugin", "plugin.json")]) {
    if (existsSync(p)) {
      try { plugin = JSON.parse(readFileSync(p, "utf-8")); break; } catch {}
    }
  }

  // ── workflow 信息 ────────────────────────────
  let workflow = {};
  const wfDir = join(pluginRoot, "workflows");
  if (existsSync(wfDir)) {
    for (const f of readdirSync(wfDir)) {
      if (f.endsWith(".yaml") || f.endsWith(".yml")) {
        // 只读 id/name/version 等头部信息（不解析整个 YAML）
        const content = readFileSync(join(wfDir, f), "utf-8");
        const idMatch = content.match(/^\s*id:\s*(.+)/m);
        const nameMatch = content.match(/^\s*name:\s*(.+)/m);
        const verMatch = content.match(/^\s*version:\s*(.+)/m);
        workflow = {
          id: idMatch ? idMatch[1].trim().replace(/['"]/g, "") : undefined,
          name: nameMatch ? nameMatch[1].trim().replace(/['"]/g, "") : undefined,
          version: verMatch ? verMatch[1].trim().replace(/['"]/g, "") : undefined,
          filename: f,
        };
        break;
      }
    }
  }

  // 从 state 提取 stages/steps summary（兼容数组和对象两种格式）
  const stagesArr = Array.isArray(state.stages)
    ? state.stages
    : Object.entries(state.stages || {}).map(([id, s]) => ({ id, ...s }));
  const stagesSummary = stagesArr.map(s => ({
    id: s.id,
    name: s.name,
    status: s.status,
    // state.json 中 stages 使用 trace_started_at / trace_completed_at
    started_at: s.started_at || s.trace_started_at,
    completed_at: s.completed_at || s.trace_completed_at,
  }));
  const stepsArr = Array.isArray(state.steps)
    ? state.steps
    : Object.entries(state.steps || {}).map(([id, s]) => ({ id, ...s }));
  const stepsSummary = stepsArr.map(s => ({
    id: s.id,
    name: s.name,
    status: s.status,
    // state.json 中 steps 没有 stage_id / skill 字段，保留可选访问
    stage_id: s.stage_id,
    skill: s.skill,
    // state.json 中 steps 没有 started_at / completed_at，时间戳在 events.jsonl 中
    started_at: s.started_at || s.trace_started_at,
    completed_at: s.completed_at || s.trace_completed_at,
    retry_count: s.retry_count,
    review_retry_count: s.review_retry_count,
  }));

  // ── engine 信息 ──────────────────────────────
  // state.json 中引擎版本字段名是 "engine"（如 "0.2.1"），不是 "engine_version"
  const engine = {
    name: "@codeagent3-temp/harness-engine",
    version: state.engine || state.engine_version || "0.2.x",
  };

  // ── components: skills ───────────────────────
  const skills = [];
  const skillsDir = join(pluginRoot, "skills");
  if (existsSync(skillsDir)) {
    for (const entry of readdirSync(skillsDir)) {
      const skillPath = join(skillsDir, entry);
      try {
        const st = statSync(skillPath);
        if (st.isDirectory()) {
          skills.push({ name: entry, path: `skills/${entry}/` });
        }
      } catch {}
    }
  }

  // ── components: mcp_servers ───────────────────
  let mcpServers = [];
  const extPath = join(pluginRoot, "codeagent-extension.json");
  if (existsSync(extPath)) {
    try {
      const ext = JSON.parse(readFileSync(extPath, "utf-8"));
      if (ext.mcp && ext.mcp.mcpServers) {
        mcpServers = Object.entries(ext.mcp.mcpServers).map(([name, cfg]) => ({
          name,
          command: cfg.command || "",
          args: cfg.args || [],
        }));
      }
    } catch {}
  }

  // ── components: hooks ─────────────────────────
  let hooksInfo = {};
  const hooksPath = join(pluginRoot, "hooks", "hooks.json");
  if (existsSync(hooksPath)) {
    try {
      const hooksCfg = JSON.parse(readFileSync(hooksPath, "utf-8"));
      const h = hooksCfg.hooks || {};
      hooksInfo = {
        PreToolUse: !!(h.PreToolUse && h.PreToolUse.length),
        Stop: !!(h.Stop && h.Stop.length),
      };
    } catch {}
  }

  // ── sessions summary ─────────────────────────
  const sessionsSummary = sessions.map(s => ({
    session_id: s.sessionId,
    role: s.role,
    jsonl_file: s.jsonlFile,
    subagent_count: s.subagentCount,
    bytes: s.bytes,
  }));

  // ── 组装 manifest ────────────────────────────
  return {
    schema: "harness.session-upload.v1",
    generated_at: new Date().toISOString(),
    run: {
      run_id: state.run_id,
      session_id: state.session_id,
      workflow_id: workflow.id,
      workflow_version: workflow.version,
      workflow_engine: state.workflow_engine,
      engine_version: state.engine || state.engine_version,
      interaction_mode: state.interaction_mode,
      started_at: state.started_at,
      completed_at: state.completed_at || state.updated_at,
      user_input: state.user_input,
      status: state.status,
      stages_summary: stagesSummary,
      steps_summary: stepsSummary,
    },
    plugin: {
      name: plugin.name,
      version: plugin.version,
      description: plugin.description,
    },
    engine,
    workflow: {
      id: workflow.id,
      name: workflow.name,
      version: workflow.version,
      stages_count: stagesSummary.length,
      steps_count: stepsSummary.length,
    },
    components: {
      skills,
      mcp_servers: mcpServers,
      hooks: hooksInfo,
    },
    sessions: sessionsSummary,
    extensions: {},
  };
}
