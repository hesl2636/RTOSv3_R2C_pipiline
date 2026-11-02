/**
 * omp `session_stop` carrier.
 *
 * omp loads this factory from `.omp/hooks/post/*.ts` (project) or
 * `~/.omp/agent/hooks/post/*.ts` (user). The hook runtime is omp's embedded
 * Bun: the runtime executable is omp itself, so the shim must be launched
 * with the `node` found on PATH.
 *
 * `{decision:"block",reason}` is a hard continuation that does not consume
 * omp's own retry allowance. The shared shim therefore honours
 * `stop_hook_active` and caps blocks at 8 per (run_id, step_id); this carrier
 * only translates the shim's JSON into omp's envelope.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

const SHIM = String.raw`${PAYLOAD_HOME}/shims/hook.mjs`;
const RUNNER_CMD = String.raw`${RUNNER_CMD}`;
const FALLBACK_PROJECT_ROOT = String.raw`${PROJECT_ROOT}`;

function resolveNode() {
  const names = process.platform === "win32" ? ["node.exe", "node"] : ["node"];
  for (const entry of String(process.env.PATH ?? "").split(delimiter)) {
    const dir = entry.replace(/^"|"$/g, "");
    if (dir === "") continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return "node";
}

function safeContext(ctx) {
  try {
    const cwd = ctx !== null && ctx !== undefined && typeof ctx.cwd === "string" && ctx.cwd !== ""
      ? ctx.cwd
      : null;
    return { cwd };
  } catch {
    return { cwd: null };
  }
}

function runShim(args, input, cwd) {
  const { promise, resolve } = Promise.withResolvers();
  let child;
  try {
    child = spawn(resolveNode(), [SHIM, ...args], {
      cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    resolve({ code: 1, stdout: "", stderr: "" });
    return promise;
  }
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  child.on("error", () => resolve({ code: 1, stdout, stderr }));
  child.on("close", (code) => resolve({ code: code === null ? 1 : code, stdout, stderr }));
  try {
    child.stdin.end(input);
  } catch {
    resolve({ code: 1, stdout, stderr });
  }
  return promise;
}

export default function r2cStop(pi) {
  pi.on("session_stop", async (event, ctx) => {
    try {
      const sessionId = event !== null && event !== undefined && typeof event.session_id === "string"
        ? event.session_id
        : null;
      if (sessionId === null || sessionId === "") return undefined;

      const context = safeContext(ctx);
      const projectRoot = context.cwd !== null ? context.cwd : FALLBACK_PROJECT_ROOT;
      const payload = {
        session_id: sessionId,
        cwd: projectRoot,
        stop_hook_active: event.stop_hook_active === true,
      };
      if (typeof event.session_file === "string" && event.session_file !== "") {
        payload.transcript_path = event.session_file;
      }
      if (typeof event.model === "string" && event.model !== "") payload.model = event.model;

      const result = await runShim(
        [
          "--agent",
          "omp",
          "--event",
          "stop",
          "--format",
          "json",
          "--runner-cmd",
          RUNNER_CMD,
          "--project-root",
          projectRoot,
          "--session-id",
          sessionId,
        ],
        JSON.stringify(payload),
        projectRoot,
      );
      if (result.code !== 0) return undefined;

      const text = result.stdout.trim();
      if (text === "") return undefined;
      const envelope = JSON.parse(text);
      if (
        envelope !== null &&
        typeof envelope === "object" &&
        envelope.decision === "block" &&
        typeof envelope.reason === "string" &&
        envelope.reason !== ""
      ) {
        return { decision: "block", reason: envelope.reason };
      }
      return undefined;
    } catch {
      // A hook failure must never be reported as progress: pass through.
      return undefined;
    }
  });
}
