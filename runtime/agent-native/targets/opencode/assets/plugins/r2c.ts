/**
 * r2c opencode V1 plugin (A′ hand-off).
 *
 * opencode has no blocking "stop" hook: the plugin subscribes to
 * `session.idle`, asks the shared shim for the next step as plain text
 * (`hook stop --format plain --session-id <sid>`, which also exercises the
 * one-time claim channel), and injects that text as a new user turn through
 * `client.session.prompt`. `tool.execute.before` forwards to the shim and
 * throws when the runner denies a protected state write.
 *
 * Only `R2cPlugin` is exported: opencode treats every module export as a
 * plugin function. Test helpers hang off the function object instead.
 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const SHIM_PATH = String.raw`${PAYLOAD_HOME}/shims/hook.mjs`;
const PROJECT_ROOT = String.raw`${PROJECT_ROOT}`;
const RUNNER_CMD = String.raw`${RUNNER_CMD}`;
const NODE_CMD = process.env.R2C_NODE_BIN || "node";
const CALL_TIMEOUT_MS = 30_000;

function quote(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`;
}

function defaultRuntime(overrides = {}) {
  const projectRoot = overrides.projectRoot ?? PROJECT_ROOT;
  return {
    shimPath: SHIM_PATH,
    runnerCmd: RUNNER_CMD,
    projectRoot,
    pluginData: join(projectRoot, ".r2c", "runs", ".hooks"),
    ...overrides,
  };
}

/** Per-plugin-instance injection watermarks: last key + count per run. */
function createIdleState() {
  return { lastKey: null, pendingKey: null, injections: new Map() };
}

function sessionIdFromEvent(event) {
  const properties = event?.properties ?? {};
  const candidates = [
    properties.sessionID,
    properties.sessionId,
    properties.session_id,
    properties.id,
    event?.sessionID,
    event?.sessionId,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}

function parseJsonLine(stdout) {
  if (typeof stdout !== "string") return null;
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const value = JSON.parse(lines[index]);
      if (value !== null && typeof value === "object") return value;
    } catch {
      // keep looking: a line after the envelope is diagnostic noise
    }
  }
  return null;
}

/** `status --json` envelope → ids, only for a running run with an active step. */
function parseStatus(stdout) {
  const envelope = parseJsonLine(stdout);
  const runId = envelope?.data?.run?.run_id ?? null;
  const stepId = envelope?.data?.next?.id ?? null;
  const runStatus = envelope?.data?.run?.status ?? null;
  const stepStatus = envelope?.data?.next?.status ?? null;
  if (typeof runId !== "string" || typeof stepId !== "string") return null;
  return { runId, stepId, runStatus, stepStatus };
}

function isActiveStatus(status) {
  return status !== null && status.runStatus === "running" && status.stepStatus === "active";
}

function parseStepId(text) {
  if (typeof text !== "string") return null;
  const match = /--step\s+["']?([^\s"']+)/.exec(text);
  return match === null ? null : match[1];
}

function injectionKey(runId, stepId) {
  return `${runId}::${stepId}`;
}

function runProcess(command, args, { cwd, input, shell = false } = {}) {
  const { promise, resolve } = Promise.withResolvers();
  let settled = false;
  let timer;
  const finish = (value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(value);
  };
  let child;
  try {
    child = spawn(command, args, {
      cwd,
      shell,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    finish({ exitCode: 1, stdout: "", stderr: error?.message ?? String(error) });
    return promise;
  }
  let stdout = "";
  let stderr = "";
  timer = setTimeout(() => {
    try {
      child.kill();
    } catch {
      // already gone
    }
    finish({ exitCode: 1, stdout, stderr: `${stderr}\ntimeout after ${CALL_TIMEOUT_MS}ms` });
  }, CALL_TIMEOUT_MS);
  timer.unref?.();
  child.stdout?.on("data", (chunk) => { stdout += chunk; });
  child.stderr?.on("data", (chunk) => { stderr += chunk; });
  child.on("error", (error) => {
    finish({ exitCode: 1, stdout, stderr: `${stderr}${error?.message ?? String(error)}` });
  });
  child.on("close", (code) => {
    finish({ exitCode: code ?? 1, stdout, stderr });
  });
  try {
    child.stdin.end(input ?? "");
  } catch {
    // the child may have exited already
  }
  return promise;
}

function runShim(runtime, args, input) {
  return runProcess(NODE_CMD, [runtime.shimPath, ...args], {
    cwd: runtime.projectRoot,
    input: input ?? "",
  });
}

function queryStatus(runtime, sessionId) {
  const line = [
    runtime.runnerCmd,
    "status",
    "--json",
    "--session-id",
    quote(sessionId),
    "--project-root",
    quote(runtime.projectRoot),
  ].join(" ");
  return runProcess(line, [], {
    cwd: runtime.projectRoot,
    shell: true,
    input: "",
  });
}

function appendTrace(runtime, entry) {
  try {
    const dir = join(runtime.pluginData, "trace");
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      join(dir, "opencode.jsonl"),
      `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`,
    );
  } catch {
    // trace is diagnostic only
  }
}

function stopViaShim(runtime, sessionId, cap) {
  return runShim(runtime, [
    "stop",
    "--agent", "opencode",
    "--event", "stop",
    "--format", "plain",
    "--runner-cmd", runtime.runnerCmd,
    "--project-root", runtime.projectRoot,
    "--session-id", sessionId,
    "--cap", String(cap),
  ]);
}

async function inject(client, sessionId, text) {
  if (client === null || typeof client !== "object") return false;
  const session = client.session;
  if (session === null || typeof session !== "object" || typeof session.prompt !== "function") {
    return false;
  }
  const result = await session.prompt({
    path: { id: sessionId },
    body: { parts: [{ type: "text", text }] },
  });
  if (result !== null && typeof result === "object" && result.error) {
    throw new Error(result.error.message ?? "session.prompt failed");
  }
  return true;
}

/**
 * One `session.idle` tick. Never throws: an idle handler must not break a
 * session. Returns `{ injected, reason, runId, stepId, text }`.
 */
async function handleIdle({
  event,
  client,
  state = createIdleState(),
  runtime = defaultRuntime(),
  cap = 32,
} = {}) {
  try {
    const sessionId = sessionIdFromEvent(event);
    if (sessionId === null) {
      appendTrace(runtime, { hook: "idle", session_id: null, delivered: false, reason: "no-session" });
      return { injected: false, reason: "no-session", runId: null, stepId: null };
    }
    if (
      !client ||
      !client.session ||
      typeof client.session.prompt !== "function"
    ) {
      appendTrace(runtime, { hook: "idle", session_id: sessionId, delivered: false, reason: "no-client" });
      return { injected: false, reason: "no-client", runId: null, stepId: null };
    }

    // Watermark check first: a routed run is usually visible without another
    // stop call, so a repeated idle for the same step never reaches the shim.
    const before = parseStatus((await queryStatus(runtime, sessionId)).stdout);
    if (isActiveStatus(before)) {
      const key = injectionKey(before.runId, before.stepId);
      if (state.lastKey === key || state.pendingKey === key) {
        appendTrace(runtime, {
          hook: "idle", session_id: sessionId, run_id: before.runId, step_id: before.stepId,
          delivered: false, reason: "duplicate",
        });
        return { injected: false, reason: "duplicate", runId: before.runId, stepId: before.stepId };
      }
      if ((state.injections.get(before.runId) ?? 0) >= cap) {
        appendTrace(runtime, {
          hook: "idle", session_id: sessionId, run_id: before.runId, step_id: before.stepId,
          delivered: false, reason: "capped", cap,
        });
        return { injected: false, reason: "capped", runId: before.runId, stepId: before.stepId };
      }
    }

    const stopped = await stopViaShim(runtime, sessionId, cap);
    const text = typeof stopped.stdout === "string" ? stopped.stdout.trimEnd() : "";
    if (stopped.exitCode !== 0) {
      appendTrace(runtime, {
        hook: "idle", session_id: sessionId, delivered: false,
        reason: `shim-exit-${stopped.exitCode}`, stderr: stopped.stderr?.trim() ?? "",
      });
      return { injected: false, reason: "hook-failed", runId: null, stepId: null };
    }
    if (text.trim() === "") {
      appendTrace(runtime, { hook: "idle", session_id: sessionId, delivered: false, reason: "no-run" });
      return { injected: false, reason: "no-run", runId: null, stepId: null };
    }

    // A first idle claims a minted `cli-` run; the routed status is the only
    // reliable source of the run id used for the watermark.
    let status = parseStatus((await queryStatus(runtime, sessionId)).stdout);
    let runId = isActiveStatus(status) ? status.runId : null;
    let stepId = isActiveStatus(status) ? status.stepId : parseStepId(text);
    if (runId === null || stepId === null) {
      appendTrace(runtime, {
        hook: "idle", session_id: sessionId, delivered: false, reason: "unresolved-run",
      });
      return { injected: false, reason: "unresolved-run", runId: runId, stepId: stepId, text };
    }

    const key = injectionKey(runId, stepId);
    if (state.lastKey === key || state.pendingKey === key) {
      appendTrace(runtime, {
        hook: "idle", session_id: sessionId, run_id: runId, step_id: stepId,
        delivered: false, reason: "duplicate",
      });
      return { injected: false, reason: "duplicate", runId, stepId, text };
    }
    const count = state.injections.get(runId) ?? 0;
    if (count >= cap) {
      appendTrace(runtime, {
        hook: "idle", session_id: sessionId, run_id: runId, step_id: stepId,
        delivered: false, reason: "capped", cap,
      });
      return { injected: false, reason: "capped", runId, stepId, text };
    }

    state.pendingKey = key;
    try {
      await inject(client, sessionId, text);
    } finally {
      if (state.pendingKey === key) state.pendingKey = null;
    }
    state.lastKey = key;
    state.injections.set(runId, count + 1);
    appendTrace(runtime, {
      hook: "idle", session_id: sessionId, run_id: runId, step_id: stepId,
      delivered: true, injection: count + 1,
    });
    return { injected: true, reason: "injected", runId, stepId, text };
  } catch (error) {
    try {
      appendTrace(runtime, {
        hook: "idle", delivered: false,
        reason: `error:${error?.message ?? String(error)}`,
      });
    } catch {
      // never throw out of idle
    }
    return { injected: false, reason: `error:${error?.message ?? String(error)}`, runId: null, stepId: null };
  }
}

/** `tool.execute.before`: throw only on the runner's deny (exit 2). */
async function guardTool({ input = {}, output = {}, runtime = defaultRuntime() } = {}) {
  const sessionId = input?.sessionID ?? input?.sessionId ?? input?.session_id ?? null;
  const payload = {
    session_id: sessionId,
    cwd: runtime.projectRoot,
    tool_name: input?.tool ?? input?.tool_name ?? null,
    tool_input: output?.args ?? input?.args ?? {},
  };
  const args = [
    "pre-tool-use",
    "--agent", "opencode",
    "--event", "pre-tool-use",
    "--format", "json",
    "--runner-cmd", runtime.runnerCmd,
    "--project-root", runtime.projectRoot,
  ];
  if (typeof sessionId === "string" && sessionId !== "") args.push("--session-id", sessionId);
  let encoded;
  try {
    encoded = JSON.stringify(payload);
  } catch {
    return { blocked: false };
  }
  const result = await runShim(runtime, args, encoded);
  if (result.exitCode !== 2) return { blocked: false };
  const denied = parseJsonLine(result.stdout);
  const reason = typeof denied?.reason === "string"
    ? denied.reason
    : typeof denied?.permissionDecisionReason === "string"
      ? denied.permissionDecisionReason
      : "denied by r2c guard";
  throw new Error(reason);
}

/**
 * opencode V1 plugin entry. opencode calls every exported function with the
 * plugin context; helpers are attached as properties so they are not mistaken
 * for plugins.
 */
export async function R2cPlugin(ctx = {}) {
  const runtime = defaultRuntime(
    typeof ctx.directory === "string" && ctx.directory !== ""
      ? { projectRoot: ctx.directory }
      : {},
  );
  const state = createIdleState();

  return {
    event: async ({ event }) => {
      if (event?.type !== "session.idle") return;
      await handleIdle({ event, client: ctx.client, state, runtime });
    },
    "tool.execute.before": async (input, output) => {
      await guardTool({ input, output, runtime });
    },
  };
}

Object.assign(R2cPlugin, {
  defaultRuntime,
  createIdleState,
  sessionIdFromEvent,
  parseJsonLine,
  parseStatus,
  isActiveStatus,
  parseStepId,
  injectionKey,
  handleIdle,
  guardTool,
  INJECTION_CAP: 32,
});
