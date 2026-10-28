#!/usr/bin/env node
/**
 * upload-session.mjs — 独立 session 上传脚本
 *
 * 调用方式:
 *   node upload-session.mjs --legacy-plugin-root <path> --project-root <path> --session-id <id>
 *   node upload-session.mjs  (自动搜索 plugin root 和 project root)
 *
 * 退出码: 始终 0（不阻塞 workflow）
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, appendFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 5000;  // 基础延迟 5 秒，指数退避: 5s, 10s, 20s

// ── 调试日志 ──────────────────────────────────────────────
const _debugLogPath = process.env.CA_HOOK_DEBUG_LOG
  || join(homedir(), ".legacy-state", "hook-debug.log");
function debugLog(msg) {
  try {
    const dir = dirname(_debugLogPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(_debugLogPath, `[${new Date().toISOString()}] [upload-session] ${msg}\n`);
  } catch {}
}

// ── 参数解析 ──────────────────────────────────────────────
function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--legacy-plugin-root") args.pluginRoot = argv[++i];
    else if (a === "--project-root") args.projectRoot = argv[++i];
    else if (a === "--session-id") args.sessionId = argv[++i];
    else if (a === "--force") args.force = true;
  }
  return args;
}

// ── 搜索 plugin root ──────────────────────────────────────
function findPluginRoot() {
  // 1. 尝试 __dirname 的上级目录（如果脚本在 plugin 内运行）
  let candidate = __dirname;
  for (let i = 0; i < 3; i++) {
    if (existsSync(join(candidate, "config.json")) && existsSync(join(candidate, "plugin.json"))) {
      return candidate;
    }
    candidate = dirname(candidate);
  }

  // 2. 搜索 ~/.legacy-state/plugins/marketplaces/*/*/
  const base = join(homedir(), ".legacy-state", "plugins", "marketplaces");
  if (!existsSync(base)) return null;
  try {
    for (const m of readdirSync(base)) {
      const mp = join(base, m);
      try {
        for (const pl of readdirSync(mp)) {
          const pp = join(mp, pl);
          if (existsSync(join(pp, "config.json")) && existsSync(join(pp, "scripts", "upload-session.mjs"))) {
            return pp;
          }
        }
      } catch {}
    }
  } catch {}
  return null;
}

// ── 路径工具（兼容新旧 projectId 编码）──────────────────────
// 新规则（CodeAgentCLI run-dir.js formatProjectId）：path.resolve + 反斜杠转正斜杠 +
//   非 [A-Za-z0-9] → "-"（保留首尾连字符），长度 >120 时截断 109 + sha1 前 10 位
// 旧规则：原始 projectRoot 替换 + 剥首尾连字符
function formatProjectId(projectRoot) {
  const normalized = resolve(projectRoot).replace(/\\/g, "/");
  const slug = normalized.replace(/[^A-Za-z0-9]/g, "-");
  if (slug.length <= 120) return slug || "project";
  const hash = createHash("sha1").update(normalized).digest("hex").slice(0, 10);
  return `${slug.slice(0, 109)}-${hash}`;
}

function getProjectsCandidates(projectRoot) {
  const newRule = formatProjectId(projectRoot);
  const oldRule = projectRoot.replace(/[^a-zA-Z0-9]/g, "-").replace(/^-+|-+$/g, "");
  return [...new Set([newRule, oldRule])].filter(Boolean).map(id => join(homedir(), ".legacy-state", "projects", id));
}

// ── 解析用户工号（用于上传 userId 字段）─────────────────────
function resolveUserId() {
  // 1. 尝试从 ~/.legacy-state/.credentials.json 读取 idaasOAuth.accountId（IdaaS 认证工号）
  try {
    const credPath = join(homedir(), ".legacy-state", ".credentials.json");
    if (existsSync(credPath)) {
      const cred = JSON.parse(readFileSync(credPath, "utf-8"));
      if (cred.idaasOAuth?.accountId) {
        debugLog(`userId resolved from .credentials.json: ${cred.idaasOAuth.accountId}`);
        return cred.idaasOAuth.accountId;
      }
    }
  } catch (e) {
    debugLog(`Failed to read .credentials.json: ${e.message}`);
  }
  // 2. 回退到系统环境变量（Windows: USERNAME, Linux/macOS: LOGNAME）
  const envUser = process.env.USERNAME || process.env.LOGNAME;
  if (envUser) {
    debugLog(`userId resolved from env: ${envUser}`);
    return envUser;
  }
  // 3. 最终回退
  debugLog(`userId fallback to "system"`);
  return "system";
}

// ── 查找当前 run（兼容新旧 projectId 候选目录）────────────
function findCurrentRun(projectsCandidates, sessionId) {
  for (const base of projectsCandidates) {
    const runsDir = join(base, "runs");
    if (!existsSync(runsDir)) continue;

    const entries = readdirSync(runsDir)
      .filter(e => e.startsWith("R"))
      .sort()
      .reverse(); // 最新的在前

    // 1. 如果有 sessionId，优先匹配 state.json 中的 session_id
    if (sessionId) {
      for (const e of entries) {
        const sp = join(runsDir, e, "state.json");
        if (!existsSync(sp)) continue;
        try {
          const st = JSON.parse(readFileSync(sp, "utf-8"));
          if (st.session_id === sessionId) {
            return { runDir: join(runsDir, e), runId: e, state: st };
          }
        } catch {}
      }
    }

    // 2. 回退到最新的 run
    for (const e of entries) {
      const sp = join(runsDir, e, "state.json");
      if (!existsSync(sp)) continue;
      try {
        const st = JSON.parse(readFileSync(sp, "utf-8"));
        return { runDir: join(runsDir, e), runId: e, state: st };
      } catch {}
    }
  }

  return null;
}

// ── 上传单个 run（带重试）────────────────────────────────
// force=true 时绕过 upload-marker.json 跳过逻辑（手动 /upload 命令重报）
async function uploadRunWithRetry(pluginRoot, projectRoot, runDir, state, config, libModules, sessionId, force) {
  const { collectSessions, buildManifest, uploadBundle } = libModules;
  const markerPath = join(runDir, "upload-marker.json");

  // 自动上传（shell step）已成功时跳过；手动重报（--force）始终重新上传
  if (!force && existsSync(markerPath)) {
    try {
      const marker = JSON.parse(readFileSync(markerPath, "utf-8"));
      if (marker.upload_status === "ok" && (marker.sessions_count ?? 0) > 0) {
        console.log(`[upload-session] Run ${state.run_id} already uploaded (${marker.sessions_count} sessions), skipping.`);
        return { ok: true, skipped: true };
      }
      // upload_status === "ok" 但 sessions_count === 0：之前的空上传，需要重试
      if (marker.upload_status === "ok" && (marker.sessions_count ?? 0) === 0) {
        debugLog(`Previous upload had 0 sessions, will retry.`);
      }
    } catch {}
  }

  let lastError = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      debugLog(`Attempt ${attempt}/${MAX_RETRIES} for run ${state.run_id}`);

      const sessions = collectSessions(projectRoot, state, { runDir, force });

      // P0-2: sessions 为空时不应该上传空 zip
      if (sessions.length === 0) {
        const reason = `No sessions collected for run ${state.run_id} (session_id=${state.session_id || "missing"})`;
        console.error(`[upload-session] ${reason}`);
        debugLog(reason);
        lastError = reason;
        // 不写 ok marker，让后续 /upload 命令可以重试
        // 也不写 failed marker，因为这不是上传失败而是数据未就绪
        // 继续下一次重试（可能 session 文件还在写入中）
        if (attempt < MAX_RETRIES) {
          const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
          console.log(`[upload-session] Retrying in ${delay / 1000}s...`);
          await new Promise(r => setTimeout(r, delay));
        }
        continue;
      }

      const manifest = buildManifest(pluginRoot, projectRoot, runDir, state, sessions);
      const uploadResult = await uploadBundle(sessions, manifest, config, runDir);

      if (uploadResult.ok) {
        writeFileSync(markerPath, JSON.stringify({
          uploaded_at: new Date().toISOString(),
          run_id: state.run_id,
          sessions_count: sessions.length,
          upload_status: "ok",
          upload_response: uploadResult.body?.slice(0, 500),
          source: "shell-step",
          run_status_at_upload: state.status,
        }, null, 2));

        console.log(`[upload-session] Upload succeeded (attempt ${attempt}): ${sessions.length} sessions`);
        // 分析由 workflow 的 Session Analysis stage 负责执行（顺序 stage），
        // 不再在此 detached spawn，避免 analyze 双跑 + 读取不完整 session 的时序问题。

        return { ok: true, sessionsCount: sessions.length };
      }

      lastError = `HTTP ${uploadResult.status}: ${uploadResult.body?.slice(0, 200)}`;
      console.error(`[upload-session] Attempt ${attempt} failed: ${lastError}`);
    } catch (e) {
      lastError = e.message;
      console.error(`[upload-session] Attempt ${attempt} error: ${e.message}`);
      debugLog(`Attempt ${attempt} error: ${e.message}\n${e.stack}`);
    }

    if (attempt < MAX_RETRIES) {
      const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      console.log(`[upload-session] Retrying in ${delay / 1000}s...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  // 所有重试失败
  writeFileSync(markerPath, JSON.stringify({
    uploaded_at: new Date().toISOString(),
    run_id: state.run_id,
    upload_status: "failed",
    error: lastError,
    retries: MAX_RETRIES,
    source: "shell-step",
    run_status_at_upload: state.status,
  }, null, 2));

  console.error(`[upload-session] All ${MAX_RETRIES} attempts failed for run ${state.run_id}. Use /upload to retry manually.`);
  return { ok: false, error: lastError };
}

// ── 主流程 ────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv);

  // 1. 确定 plugin root (优先 CLI 参数 > 环境变量 > 搜索)
  let pluginRoot = args.pluginRoot || process.env.LEGACY_PLUGIN_ROOT || findPluginRoot();
  if (!pluginRoot) {
    console.error("[upload-session] Could not find plugin root. Use --legacy-plugin-root to specify.");
    return; // exit 0, don't block workflow
  }
  debugLog(`pluginRoot=${pluginRoot}`);

  // 2. 读 config
  const configPath = join(pluginRoot, "config.json");
  if (!existsSync(configPath)) {
    console.error("[upload-session] config.json not found in plugin root.");
    return;
  }
  const config = JSON.parse(readFileSync(configPath, "utf-8"));

  if (!config.uploadUrl) {
    console.error("[upload-session] No uploadUrl configured.");
    return;
  }

  // 3. 确定 project root 和 session id
  const projectRoot = resolve(args.projectRoot || process.cwd());
  const sessionId = args.sessionId || process.env.LEGACY_SESSION_ID || "";
  debugLog(`projectRoot=${projectRoot} sessionId=${sessionId}`);

  // 3.1 动态计算 projectId（编码路径格式，ca-viewer /api/imports 接口要求）
  // Windows: D:\7.30\configStudio → D--7-30-configStudio（盘符冒号 → --，命中 ca-viewer legacy 格式）
  // POSIX: /home/user/project → -home-user-project（前导 / → -，必须保留前导 -；
  //   ca-viewer isValidEncodedPath 要求以 - 开头表示绝对路径，剥掉会被拒绝 HTTP 400）
  // 统一使用 formatProjectId（与引擎 run-dir.js 一致）：resolve + 非字母数字转 - + >120 截断 sha1
  const projectId = formatProjectId(projectRoot);
  config.uploadFields = config.uploadFields || {};
  config.uploadFields.projectId = projectId;
  // 动态解析用户工号，覆盖 config.json 中的静态默认值
  config.uploadFields.userId = resolveUserId();
  debugLog(`projectId=${projectId}`);

  // 4. 查找当前 run（兼容新旧 projectId 编码）
  const projectsCandidates = getProjectsCandidates(projectRoot);
  const currentRun = findCurrentRun(projectsCandidates, sessionId);
  if (!currentRun) {
    console.error("[upload-session] No run found for this project.");
    return;
  }

  debugLog(`Found run ${currentRun.runId} (status=${currentRun.state.status})`);

  // 5. 动态导入上传模块
  // Windows 兼容: 先 resolve 为绝对路径再转 file:// URL，避免 ERR_UNSUPPORTED_ESM_URL_SCHEME
  const libDir = resolve(join(pluginRoot, "scripts", "lib"));
  const libModules = {
    collectSessions: (await import(pathToFileURL(join(libDir, "collect-sessions.mjs")).href)).collectSessions,
    buildManifest: (await import(pathToFileURL(join(libDir, "build-manifest.mjs")).href)).buildManifest,
    uploadBundle: (await import(pathToFileURL(join(libDir, "upload-bundle.mjs")).href)).uploadBundle,
  };

  // 6. 上传（带重试）。手动 /upload 命令通过 CA_UPLOAD_FORCE=1 强制重报
  const force = !!(args.force || process.env.CA_UPLOAD_FORCE === "1");
  const result = await uploadRunWithRetry(
    pluginRoot, projectRoot, currentRun.runDir, currentRun.state, config, libModules, sessionId, force
  );

  if (result.ok) {
    debugLog(`Upload completed: ok=true, sessions=${result.sessionsCount || 0}`);
  } else {
    debugLog(`Upload failed after retries: ${result.error}`);
  }
}

main().catch(e => {
  console.error(`[upload-session] Fatal: ${e.message}`);
  debugLog(`FATAL: ${e.message}\n${e.stack}`);
  // exit 0 — never block workflow
});
