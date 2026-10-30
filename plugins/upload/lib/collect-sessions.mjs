/**
 * collect-sessions.mjs — 收集与当前 workflow run 相关的所有 session 文件
 *
 * 策略:
 *   1. 从 state.session_id 获取 harness session
 *   2. 多 run 会话检测：同一 session 被多个 run 共享时，本 run 只上报
 *      [started_at, updated_at] 窗口内的切片，并用派生 id <sessionId>_<runId>
 *      记录，避免第二次上传覆盖第一次的记录（主 transcript + subagents + memory）
 *   3. 单 run 会话保持整份上报，行为不变
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, basename, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

/**
 * 兼容新旧 projectId 编码规则（与 upload-session.mjs 一致）：
 *   - 新规则（CodeAgentCLI run-dir.js formatProjectId）：path.resolve + 反斜杠转正斜杠 +
 *     非 [A-Za-z0-9] → "-"，保留首尾连字符（路径含中文时尾部有一串 "-"），长度 >120 截断+sha1
 *   - 旧规则：原始 projectRoot 替换 + 剥首尾连字符
 * 返回第一个实际存在的候选目录；都不存在时回退到新规则目录。
 */
function formatProjectId(projectRoot) {
  const normalized = resolve(projectRoot).replace(/\\/g, "/");
  const slug = normalized.replace(/[^A-Za-z0-9]/g, "-");
  if (slug.length <= 120) return slug || "project";
  const hash = createHash("sha1").update(normalized).digest("hex").slice(0, 10);
  return `${slug.slice(0, 109)}-${hash}`;
}

function resolveProjectsDir(projectRoot) {
  const newRule = formatProjectId(projectRoot);
  const oldRule = projectRoot.replace(/[^a-zA-Z0-9]/g, "-").replace(/^-+|-+$/g, "");
  const candidates = [...new Set([newRule, oldRule])].filter(Boolean);
  for (const id of candidates) {
    const dir = join(homedir(), ".legacy-state", "projects", id);
    if (existsSync(dir)) return dir;
  }
  return join(homedir(), ".legacy-state", "projects", candidates[0] || newRule);
}

// ── 行时间提取（session / subagent / memory jsonl 顶层均为 timestamp 字段）────
function lineTime(line) {
  try {
    const o = JSON.parse(line);
    if (o && typeof o.timestamp === "string") {
      const t = Date.parse(o.timestamp);
      return Number.isFinite(t) ? t : null;
    }
  } catch {}
  return null;
}

// ── 按时间窗口过滤 jsonl 文件，写入 outPath，返回保留行数（0 表示窗口内无内容）──
function sliceJsonlFile(srcPath, startTs, endTs, outPath) {
  const lines = readFileSync(srcPath, "utf-8").split("\n");
  const kept = [];
  for (const l of lines) {
    if (!l.trim()) continue;
    const t = lineTime(l);
    if (t === null) continue;
    if (t >= startTs && t <= endTs) kept.push(l);
  }
  if (kept.length === 0) return 0;
  try { mkdirSync(dirname(outPath), { recursive: true }); } catch {}
  writeFileSync(outPath, kept.join("\n") + "\n", "utf-8");
  return kept.length;
}

// ── 统计共享同一 session 的 run 数量（>1 表示多 run 会话）──────────────
function countRunsForSession(projectsDir, sessionId) {
  const runsDir = join(projectsDir, "runs");
  if (!existsSync(runsDir)) return 1;
  let count = 0;
  try {
    for (const e of readdirSync(runsDir)) {
      if (!e.startsWith("R")) continue;
      const sp = join(runsDir, e, "state.json");
      if (!existsSync(sp)) continue;
      try {
        const st = JSON.parse(readFileSync(sp, "utf-8"));
        if (st.session_id === sessionId) count++;
      } catch {}
    }
  } catch {}
  return count || 1;
}

// ── 派生 run 级 session id：<sessionId>_<runId>（满足 ca-viewer SESSION_ID_PATTERN）──
function deriveRunSessionId(sessionId, runId) {
  if (!runId) return sessionId;
  return `${sessionId}_${runId}`;
}

export function collectSessions(projectRoot, state, opts = {}) {
  const projectsDir = resolveProjectsDir(projectRoot);

  if (!existsSync(projectsDir)) {
    return [];
  }

  const harnessSessionId = state.session_id;
  if (!harnessSessionId) {
    return [];
  }

  const runId = state.run_id || "";
  const runDir = opts.runDir || null;
  const startTs = state.started_at ? Date.parse(state.started_at) : NaN;
  const endTs = state.updated_at ? Date.parse(state.updated_at) : NaN;

  // 多 run 检测：同一 session 被多个 run 共享时，本 run 只上报自己窗口内的切片，
  // 并用派生 id <sessionId>_<runId> 记录，避免第二次上传覆盖第一次的记录。
  const multiRun = countRunsForSession(projectsDir, harnessSessionId) > 1;
  const sliceMode = !!(
    multiRun && runDir &&
    Number.isFinite(startTs) && Number.isFinite(endTs) && startTs > 0 && endTs >= startTs
  );
  const recordSessionId = sliceMode ? deriveRunSessionId(harnessSessionId, runId) : harnessSessionId;

  const sessions = [];
  const jsonlFile = `${recordSessionId}.jsonl`;
  const sourcePath = join(projectsDir, `${harnessSessionId}.jsonl`);
  const jsonlPath = sliceMode ? join(runDir, "session-slice.jsonl") : sourcePath;

  if (!existsSync(sourcePath)) {
    return [];
  }

  let st;
  try { st = statSync(sourcePath); } catch { return []; }

  // 切片模式：主 transcript 按 [started_at, updated_at] 过滤
  if (sliceMode) {
    const kept = sliceJsonlFile(sourcePath, startTs, endTs, jsonlPath);
    if (kept <= 0) {
      // 窗口内无内容：回退整份 + 原 session id，避免空上传
      sessions.push({
        sessionId: harnessSessionId,
        role: "harness",
        jsonlPath: sourcePath,
        jsonlFile: `${harnessSessionId}.jsonl`,
        bytes: statSync(sourcePath).size,
        subagentFiles: [],
        memFiles: [],
        subagentCount: 0,
      });
      return sessions;
    }
    st = statSync(jsonlPath);
  }

  // ── 收集 subagents/（切片模式下按窗口过滤到 runDir/session-slice/subagents/）──
  const subagentDir = join(projectsDir, harnessSessionId, "subagents");
  const subagentFiles = [];
  if (existsSync(subagentDir)) {
    for (const sf of readdirSync(subagentDir)) {
      if (!sf.endsWith(".jsonl")) continue;
      const sfPath = join(subagentDir, sf);
      try {
        const sfStat = statSync(sfPath);
        let outPath = sfPath;
        let outBytes = sfStat.size;
        if (sliceMode) {
          outPath = join(runDir, "session-slice", "subagents", sf);
          const kept = sliceJsonlFile(sfPath, startTs, endTs, outPath);
          if (kept <= 0) continue;
          outBytes = statSync(outPath).size;
        }
        subagentFiles.push({ name: sf, path: outPath, bytes: outBytes });
      } catch {}
    }
  }

  // ── 收集 session-memory/（切片模式下按窗口过滤）──
  const memDir = join(projectsDir, harnessSessionId, "session-memory");
  const memFiles = [];
  if (existsSync(memDir)) {
    for (const mf of readdirSync(memDir)) {
      if (!mf.endsWith(".jsonl")) continue;
      const mfPath = join(memDir, mf);
      try {
        const mfStat = statSync(mfPath);
        let outPath = mfPath;
        let outBytes = mfStat.size;
        if (sliceMode) {
          outPath = join(runDir, "session-slice", "session-memory", mf);
          const kept = sliceJsonlFile(mfPath, startTs, endTs, outPath);
          if (kept <= 0) continue;
          outBytes = statSync(outPath).size;
        }
        memFiles.push({ name: mf, path: outPath, bytes: outBytes });
      } catch {}
    }
  }

  sessions.push({
    sessionId: recordSessionId,
    role: "harness",
    jsonlPath,
    jsonlFile,
    bytes: st.size,
    subagentFiles,
    memFiles,
    subagentCount: subagentFiles.length,
  });

  return sessions;
}
