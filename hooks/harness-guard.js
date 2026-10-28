#!/usr/bin/env node
/**
 * harness-guard.js — 插件归属守卫（只作用于 harness-engine 内置 hook）
 *
 * 仅当本插件是当前 run 的 workflow_engine 时，才真正调用 harness-engine
 * hook（pre-tool-use / stop）；非活动插件的 hook 命令快速跳过（exit 0，
 * 不阻塞、不启动 npx harness-engine）。
 *
 * 用户自定义 hook（phase-guard 等）不经过此守卫，直接执行。
 *
 * 用法（由 hooks.json 调用，${CODEAGENT3_PLUGIN_ROOT} 等由 CodeAgentCLI shell 展开）:
 *   node "<pluginRoot>/hooks/harness-guard.js" --hook pre-tool-use \
 *     --plugin-root "<pluginRoot>" --project-root . --session-id "<sid>" \
 *     --engine-npx "@codeagent3-temp/harness-engine@0.2.x" [--registry <url>] [--ssl-flag 1]
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const args = process.argv.slice(2);
function opt(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

const hook = opt("hook");
const pluginRoot = opt("plugin-root");
const projectRoot = resolve(opt("project-root") || process.cwd());
const sessionId = opt("session-id") || "";
const engineNpx = opt("engine-npx") || "@codeagent3-temp/harness-engine@0.2.x";
const registry = opt("registry") || "";
const sslFlag = opt("ssl-flag") === "1";

/** 项目ID编码 — 与引擎 run-dir.js formatProjectId 完全一致（CodeAgentCLI 规则）：
 *  1. path.resolve 规范化（反斜杠转正斜杠）
 *  2. 非 [A-Za-z0-9] → "-"（中文/空格/括号全转，保留首尾连字符）
 *  3. 长度 >120：前 109 字符 + "-" + sha1(normalized) 前 10 位（与引擎逐字节一致）
 *  4. 空结果回退 "project"
 */
function formatProjectId(projectRoot) {
  const normalized = resolve(projectRoot).replace(/\\/g, "/");
  const slug = normalized.replace(/[^A-Za-z0-9]/g, "-");
  if (slug.length <= 120) return slug || "project";
  const hash = createHash("sha1").update(normalized).digest("hex").slice(0, 10);
  return `${slug.slice(0, 109)}-${hash}`;
}

/** 按 sessionId 遍历所有 ~/.cac/projects/* 目录定位 run（兜底：cwd 漂移/编码不一致时仍能找到）。
 *  优先使用 formatProjectId(projectRoot) 编码目录；找不到时遍历全部 projects 目录，
 *  匹配 latest.json 中 runs[sessionId]（有 sessionId）或最新 active run（无 sessionId）。 */
function resolveRunDir() {
  // 1. 首选：本插件 projectRoot 编码目录
  const primary = join(homedir(), ".cac", "projects", formatProjectId(projectRoot), "runs");
  const tried = new Set([primary]);
  const tryResolve = (base) => {
    const latestPath = join(base, "latest.json");
    if (!existsSync(latestPath)) return null;
    try {
      const latest = JSON.parse(readFileSync(latestPath, "utf-8"));
      let runId = null;
      if (sessionId && latest.runs?.[sessionId]) {
        runId = latest.runs[sessionId].active_run_id || latest.runs[sessionId].latest_run_id;
      } else if (!sessionId) {
        runId = latest.active_run_id || latest.latest_run_id;
      }
      if (!runId) return null;
      const dir = join(base, runId);
      return existsSync(join(dir, "state.json")) ? dir : null;
    } catch {
      return null;
    }
  };
  const found = tryResolve(primary);
  if (found) return found;

  // 2. 兜底：遍历所有 projects 目录（兼容旧编码、cwd 漂移、超长路径 hash 不一致）
  const projectsBase = join(homedir(), ".cac", "projects");
  let fallbackDir = null;
  try {
    for (const entry of readdirSync(projectsBase)) {
      if (tried.has(join(projectsBase, entry, "runs"))) continue;
      const dir = tryResolve(join(projectsBase, entry, "runs"));
      if (dir) {
        fallbackDir = dir;
        // 有 sessionId 时命中即返回；无 sessionId 时记录最后一个（最新的）
        if (sessionId) return dir;
      }
    }
  } catch {}
  return fallbackDir;
}

/** 插件名：兼容 <market>/<name>/<version> 与 <dev>/<name> 两种根目录结构 */
function pluginNameOf(root) {
  const leaf = basename(root);
  const parent = basename(dirname(root));
  // cache/aimarket/<name>/<version>：leaf 是版本号（如 0.1.7），插件名取 parent
  if (/^\d+\.\d+/.test(leaf)) return parent;
  // plugins/dev/<name>：leaf 就是插件名
  return leaf;
}

/** 判定本插件是否为当前 run 的引擎插件 */
function isActiveEngine() {
  // 无法判定（无 run / 无状态）→ 保守放行，交给引擎自身按 session 路由 no-op
  const runDir = resolveRunDir();
  if (!runDir) return true;
  try {
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf-8"));
    const engine = state.workflow_engine || "";
    const pluginName = pluginRoot ? pluginNameOf(pluginRoot) : "";
    if (!pluginName) return true;
    const matched = engine === pluginName
      || (engine && pluginName.includes(engine))
      || (pluginName && engine.includes(pluginName));
    if (!matched) {
      console.error(`[harness-guard] skip ${hook}: plugin "${pluginName}" != workflow_engine "${engine || "(none)"}"`);
    }
    return matched;
  } catch {
    return true; // 异常保守放行
  }
}

if (!isActiveEngine()) {
  process.exit(0); // 非活动插件：不调用 harness-engine，hook 直接放行
}

// 活动插件：透传调用 harness-engine hook
const npxArgs = ["-y", "--silent"];
if (sslFlag) npxArgs.push("--strict-ssl=false");
if (registry) npxArgs.push("--registry", registry);
npxArgs.push(engineNpx, "hook", hook, "--plugin-root", pluginRoot, "--project-root", projectRoot);
if (sessionId) npxArgs.push("--session-id", sessionId);

const result = spawnSync("npx", npxArgs, {
  stdio: "inherit",
  shell: process.platform === "win32",
});
process.exit(result.status ?? 0);
