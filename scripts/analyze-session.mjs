#!/usr/bin/env node
/**
 * analyze-session.mjs — session 分析脚本
 *
 * 由 workflow 的 Session Analysis stage 执行（顺序 stage，在 Session Upload 之后）。
 * 调用 sdoc-js 分析引擎，产出归因报告。
 *
 * 退出码: 始终 0（不阻塞 workflow）
 */

import { readFileSync, existsSync, mkdirSync, readdirSync, appendFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── 调试日志 ──────────────────────────────────────────────
const _debugLogPath = join(homedir(), ".cac", "analyze-debug.log");
function debugLog(msg) {
  try {
    const logDir = dirname(_debugLogPath);
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
    appendFileSync(_debugLogPath, `[${new Date().toISOString()}] [analyze-session] ${msg}\n`);
  } catch {}
}

// ── 搜索 plugin root ──────────────────────────────────────
function findPluginRoot() {
  let candidate = __dirname;
  for (let i = 0; i < 3; i++) {
    if (existsSync(join(candidate, "config.json")) && existsSync(join(candidate, "plugin.json"))) {
      return candidate;
    }
    candidate = dirname(candidate);
  }
  return null;
}

// ── 兼容新旧 projectId 编码规则（与 upload-session.mjs / collect-sessions.mjs 一致）──────
// 新规则（CodeAgentCLI run-dir.js formatProjectId）：path.resolve + 反斜杠转正斜杠 +
//   非 [A-Za-z0-9] → "-"，保留首尾连字符（路径含中文时尾部有一串 "-"），长度 >120 截断+sha1
// 旧规则：原始 projectRoot 替换 + 剥首尾连字符
// 返回第一个实际存在的候选目录；都不存在时回退到新规则目录。
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
    const dir = join(homedir(), ".cac", "projects", id);
    if (existsSync(dir)) return dir;
  }
  return join(homedir(), ".cac", "projects", candidates[0] || newRule);
}

// ── 查找最新 run ──────────────────────────────────────────
function findLatestRun() {
  const cwd = process.cwd();
  const projectsDir = resolveProjectsDir(cwd);
  const runsDir = join(projectsDir, "runs");
  if (!existsSync(runsDir)) return null;

  const entries = readdirSync(runsDir).filter(e => e.startsWith("R")).sort().reverse();
  for (const e of entries) {
    const sp = join(runsDir, e, "state.json");
    if (!existsSync(sp)) continue;
    try {
      const st = JSON.parse(readFileSync(sp, "utf-8"));
      return { runDir: join(runsDir, e), runId: e, state: st };
    } catch {}
  }
  return null;
}

// ── 主流程 ────────────────────────────────────────────────
async function main() {
  debugLog("analyze-session started");

  // 1. 查找 plugin root
  const pluginRoot = findPluginRoot();
  if (!pluginRoot) {
    console.error("[analyze-session] plugin root not found");
    return;
  }
  debugLog(`pluginRoot=${pluginRoot}`);

  // 2. 读 config
  const configPath = join(pluginRoot, "config.json");
  if (!existsSync(configPath)) {
    console.error("[analyze-session] config.json not found");
    return;
  }
  const config = JSON.parse(readFileSync(configPath, "utf-8"));

  if (!config.enableAnalysis) {
    debugLog("analysis disabled in config");
    return;
  }

  // 3. 查找最新 run
  const run = findLatestRun();
  if (!run) {
    console.error("[analyze-session] no run found");
    return;
  }
  debugLog(`runId=${run.runId}`);

  // 4. 查找 session .jsonl
  const sessionId = run.state.session_id;
  if (!sessionId) {
    console.error("[analyze-session] no session_id in run state");
    return;
  }

  const cwd = process.cwd();
  const projectsDir = resolveProjectsDir(cwd);

  // 4.1 多 run 切片：upload 阶段已生成 runDir/session-slice.jsonl（本 run 窗口切片），
  //     优先使用，且归因记录使用派生 id <sessionId>_<runId>，避免覆盖其他 run 的记录。
  const slicePath = join(run.runDir, "session-slice.jsonl");
  const useSlice = existsSync(slicePath);
  const attributionSessionId = useSlice
    ? `${sessionId}_${run.runId}`
    : sessionId;

  let sessionPath = useSlice
    ? slicePath
    : join(projectsDir, `${sessionId}.jsonl`);
  if (!useSlice && !existsSync(sessionPath)) {
    // 尝试子目录
    const subDir = join(projectsDir, sessionId);
    if (existsSync(subDir)) {
      for (const f of readdirSync(subDir)) {
        if (f.endsWith(".jsonl") && !f.startsWith("obs")) {
          sessionPath = join(subDir, f);
          break;
        }
      }
    }
  }

  if (!existsSync(sessionPath)) {
    console.error("[analyze-session] session .jsonl not found");
    return;
  }
  debugLog(`sessionPath=${sessionPath} useSlice=${useSlice} attributionSessionId=${attributionSessionId}`);

  // 5. 准备分析输出目录
  const analysisDir = join(run.runDir, "analysis");
  mkdirSync(analysisDir, { recursive: true });

  // 6. 调用 sdoc-js 分析引擎
  const sdocIndex = join(pluginRoot, "scripts", "sdoc-js", "index.mjs");
  if (!existsSync(sdocIndex)) {
    console.error("[analyze-session] sdoc-js/index.mjs not found");
    return;
  }

  // 查找 workflow YAML 文件（优先使用 run-state 中的，用于步骤级归因分析）
  let workflowFile = null;
  // 优先检查 run-state 目录中的 workflow.yaml（旁边有 trace/events.jsonl）
  const runStateWorkflow = join(run.runDir, "workflow.yaml");
  if (existsSync(runStateWorkflow)) {
    workflowFile = runStateWorkflow;
    debugLog(`using run-state workflow: ${workflowFile}`);
  } else {
    // 回退到 plugin 的 workflows 目录
    const workflowsDir = join(pluginRoot, "workflows");
    if (existsSync(workflowsDir)) {
      const yamlFiles = readdirSync(workflowsDir).filter(f => f.endsWith(".yaml") || f.endsWith(".yml"));
      if (yamlFiles.length > 0) {
        workflowFile = join(workflowsDir, yamlFiles[0]);
        debugLog(`using plugin workflow: ${workflowFile}`);
      }
    }
  }

  const args = [
    sdocIndex,
    sessionPath,
    "--backend", "codeagent",
    "--model", config.analysisModel || "GLM-5.2-Auto(Volcano-MaaS)",
    "--out", analysisDir,
    "--run-id", run.runId,
    "--plugin-root", pluginRoot,
  ];

  // 传递 workflow 文件以支持步骤级归因分析
  if (workflowFile) {
    args.push("--workflow", workflowFile);
  }

  // 传递插件根目录（供归因分析读取外置任务文件 tasks/<stepId>.md，
  // 定位步骤完整 prompt 以分析"配置了 skill/mcp/知识库但未使用"的原因）
  if (pluginRoot) {
    args.push("--plugin-root", pluginRoot);
  }

  if (config.autoInjectKnowledge) {
    args.push("--auto-inject", "--project-root", process.cwd());
  }

  debugLog(`spawning: node ${args.join(" ")}`);

  const ANALYSIS_TIMEOUT_MS = 1800000;  // 30 分钟超时
  debugLog(`sdoc-js timeout: ${ANALYSIS_TIMEOUT_MS / 1000}s, session size: ${Math.round(readFileSync(sessionPath).length / 1024)}KB`);

  const result = spawnSync("node", args, {
    encoding: "utf-8",
    timeout: ANALYSIS_TIMEOUT_MS,
    maxBuffer: 50 * 1024 * 1024,
  });

  // ── 超时或 spawn 错误：上报失败状态到 ca-viewer ──
  if (result.error) {
    const isTimeout = result.error.code === "ETIMEDOUT";
    const errMsg = isTimeout
      ? `sdoc-js analysis timed out after ${ANALYSIS_TIMEOUT_MS / 1000}s`
      : result.error.message;
    console.error(`[analyze-session] spawn error: ${errMsg}`);
    debugLog(`spawn error: ${errMsg}`);

    // 上报失败状态到 ca-viewer
    try {
      const failResp = await fetch(`${config.uploadUrl}/api/attribution`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: attributionSessionId,
          status: "failed",
          error: errMsg,
          analyzed_at: new Date().toISOString(),
        }),
      });
      debugLog(`failure report uploaded: ${failResp.status}`);
      console.log(`[analyze-session] failure reported to server: ${failResp.status}`);
    } catch (e) {
      debugLog(`failure report upload error: ${e.message}`);
      console.error(`[analyze-session] failed to report analysis failure: ${e.message}`);
    }
    return;
  }

  if (result.status !== 0) {
    console.error(`[analyze-session] sdoc-js exited with code ${result.status}`);
    debugLog(`sdoc-js exit code=${result.status}, stderr=${result.stderr?.slice(0, 500)}`);
    console.error(result.stderr);

    // 上报失败状态到 ca-viewer
    try {
      const failResp = await fetch(`${config.uploadUrl}/api/attribution`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: attributionSessionId,
          status: "failed",
          error: `sdoc-js exited with code ${result.status}`,
          analyzed_at: new Date().toISOString(),
        }),
      });
      debugLog(`failure report uploaded: ${failResp.status}`);
      console.log(`[analyze-session] failure reported to server: ${failResp.status}`);
    } catch (e) {
      debugLog(`failure report upload error: ${e.message}`);
    }
    return;
  }

  debugLog("analysis completed successfully");
  console.log(`[analyze-session] analysis completed, output: ${analysisDir}`);

  // 7. 上传归因结果到 ca-viewer
  const attributionPath = join(analysisDir, "attribution.json");
  if (existsSync(attributionPath)) {
    try {
      const attribution = JSON.parse(readFileSync(attributionPath, "utf-8"));
      // 归因记录统一用上传记录 id（切片模式为派生 id，保证与 imports 记录一致）
      attribution.session_id = attributionSessionId;
      attribution.status = "completed";
      attribution.analyzed_at = new Date().toISOString();

      debugLog(`attribution: session_id=${attribution.session_id}, resource_anomaly=${attribution.resource_anomaly_attribution?.length ?? 0}, execution_failure=${attribution.execution_failure_attribution?.length ?? 0}, total_tokens=${attribution.metrics?.total_tokens ?? "N/A"}`);

      const attrResp = await fetch(`${config.uploadUrl}/api/attribution`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(attribution),
      });
      debugLog(`attribution upload status: ${attrResp.status}`);
      console.log(`[analyze-session] attribution uploaded: ${attrResp.status}`);
      if (!attrResp.ok) {
        const attrBody = await attrResp.text();
        debugLog(`attribution upload failed body: ${attrBody.slice(0, 300)}`);
        console.error(`[analyze-session] attribution upload failed: HTTP ${attrResp.status} ${attrBody.slice(0, 200)}`);
      }
    } catch (e) {
      console.error(`[analyze-session] attribution upload failed: ${e.message}`);
    }
  } else {
    debugLog(`attribution.json not found at ${attributionPath} — reporting failure to server`);
    console.warn(`[analyze-session] attribution.json not found, reporting analysis failure`);
    try {
      await fetch(`${config.uploadUrl}/api/attribution`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: attributionSessionId,
          status: "failed",
          error: "sdoc-js analysis did not produce attribution.json",
          analyzed_at: new Date().toISOString(),
        }),
      });
    } catch {}
  }
}

main().catch(e => {
  console.error(`[analyze-session] fatal: ${e.message}`);
  debugLog(`fatal: ${e.message}
${e.stack}`);
  process.exit(0);  // 始终 exit 0，不阻塞 workflow
});
