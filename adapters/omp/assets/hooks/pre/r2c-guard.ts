/**
 * omp `tool_call` carrier.
 *
 * The `tool_call` event carries no session id; omp exposes it through
 * `ctx.sessionManager.getSessionId()`. That access is wrapped: a throw from
 * the context chain must fall back to the shared guard without misreporting a
 * block, and the guard still runs when the session id is unavailable.
 *
 * omp's hook runtime is embedded Bun, so launch `node` from PATH rather than
 * the runtime executable (which is omp itself).
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

function safeSessionId(ctx) {
  try {
    const value = ctx?.sessionManager?.getSessionId?.();
    return typeof value === "string" && value !== "" ? value : null;
  } catch {
    return null;
  }
}

function safeCwd(ctx) {
  try {
    return ctx !== null && ctx !== undefined && typeof ctx.cwd === "string" && ctx.cwd !== ""
      ? ctx.cwd
      : null;
  } catch {
    return null;
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

export default function r2cGuard(pi) {
  pi.on("tool_call", async (event, ctx) => {
    try {
      const sessionId = safeSessionId(ctx);
      const cwd = safeCwd(ctx);
      const projectRoot = cwd !== null ? cwd : FALLBACK_PROJECT_ROOT;
      const payload = {
        session_id: sessionId,
        cwd: projectRoot,
        tool_name: event !== null && event !== undefined ? event.toolName ?? null : null,
        tool_input: event !== null && event !== undefined ? event.input ?? {} : {},
      };
      const args = [
        "--agent",
        "omp",
        "--event",
        "pre-tool-use",
        "--format",
        "json",
        "--runner-cmd",
        RUNNER_CMD,
        "--project-root",
        projectRoot,
      ];
      if (sessionId !== null) args.push("--session-id", sessionId);

      const result = await runShim(args, JSON.stringify(payload), projectRoot);
      const text = result.stdout.trim();
      if (text === "") return undefined;
      const envelope = JSON.parse(text);
      if (envelope === null || typeof envelope !== "object") return undefined;

      if (envelope.permissionDecision === "deny" || result.code === 2) {
        const reason = typeof envelope.reason === "string"
          ? envelope.reason
          : typeof envelope.permissionDecisionReason === "string"
            ? envelope.permissionDecisionReason
            : "blocked by r2c guard";
        return { block: true, reason };
      }
      return undefined;
    } catch {
      // Fail open on carrier errors; the runner remains the single authority.
      return undefined;
    }
  });
}
