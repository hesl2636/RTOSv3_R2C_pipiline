#!/usr/bin/env node
/**
 * The single payload shim between an agent's hook dialect and the r2c runner.
 *
 * It reads the agent's JSON on stdin, normalises the session/cwd, calls the
 * runner (`status`, `hook stop`, `hook pre-tool-use`) and translates the
 * result back into the agent's expected envelope. Keeping this file generic
 * means adapters only declare *where* the shim is wired, never how it works.
 *
 * Usage:
 *   node runtime/r2c/assets/shims/hook.mjs stop|pre-tool-use --runner-cmd <cmd> --agent-id <id>
 *     [--project-root <dir>] [--session-id <sid>] [--workflow <id>]
 *     [--format plain|json] [--dialect claude|codex|dsh|omp|opencode]
 *     [--cap <n>] [--plugin-data <dir>] [--trace <file>]
 *
 * Guarantees:
 * - never throws: any unexpected failure exits 0 so a hook can never wedge an
 *   agent session (the runner's exit 1/2/4/5 is always treated as "pass");
 * - only `stop` writes, and only its own stop-guard counter and trace;
 * - 8 blocks per (run_id, step_id) by default (A-档), configurable via --cap
 *   (opencode A′ passes 32); `stop_hook_active` is always honoured first;
 * - node is resolved from PATH through the shell, never process.execPath.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const argv = process.argv.slice(2);
const positional = argv[0] === 'stop' || argv[0] === 'pre-tool-use' ? argv[0] : null;

function option(name, fallback = null) {
  const prefix = `--${name}=`;
  const inline = argv.find((value) => value.startsWith(prefix));
  if (inline !== undefined) return inline.slice(prefix.length);
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  return value === undefined || value.startsWith('--') ? fallback : value;
}

const mode = positional ?? (option('event') === 'pre-tool-use' ? 'pre-tool-use' : option('event') === 'stop' ? 'stop' : null);

function numberOption(name, fallback) {
  const raw = option(name);
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

const runnerCmd = option('runner-cmd') ?? process.env.R2C_RUNNER_CMD ?? 'r2c';
const agentId = option('agent-id') ?? option('agent') ?? 'unknown';
/** Usage snapshots may only carry a declared adapter id (schema/usage.schema.json). */
const AGENT_IDS = new Set(['claude-code', 'codex', 'dsh', 'omp', 'opencode']);
const projectRoot = option('project-root') ?? process.env.R2C_PROJECT_ROOT ?? process.cwd();
const explicitSession = option('session-id') ?? process.env.R2C_SESSION_ID ?? null;
const workflow = option('workflow');
const format = option('format') ?? 'json';
const dialect = option('dialect') ?? agentId;
const cap = numberOption('cap', 8);
// Diagnostics live under `.r2c/runs/` so the five-path runtime closure stays true.
const pluginData = option('plugin-data') ?? join(projectRoot, '.r2c', 'runs', '.hooks');
const tracePath = option('trace') ?? join(pluginData, 'trace', `${agentId}.jsonl`);
const guardPath = join(pluginData, 'stop-guard.json');

if (mode === null) {
  process.stderr.write('hook.mjs: expected stop|pre-tool-use\n');
  process.exit(0);
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function parseJson(text) {
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function firstString(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

const stdinText = readStdin();
const raw = parseJson(stdinText) ?? {};
const sessionId = explicitSession
  ?? firstString(raw, ['session_id', 'sessionId', 'conversation_id', 'conversationId', 'thread_id', 'threadId']);
const stopHookActive = raw.stop_hook_active === true || raw.stopHookActive === true;

function quote(value) {
  return `"${String(value).split('"').join('\\"')}"`;
}

function runner(args, input) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(`${runnerCmd} ${args}`, {
        shell: true,
        cwd: projectRoot,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      resolvePromise({ exitCode: 1, stdout: '', stderr: '' });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', () => resolvePromise({ exitCode: 1, stdout, stderr }));
    child.on('close', (code) => resolvePromise({ exitCode: code ?? 1, stdout, stderr }));
    if (input !== undefined) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

function argsFor(command, extra) {
  const parts = [command, ...extra];
  return parts.map((part) => (part.startsWith('--') ? part : quote(part))).join(' ');
}

function appendTrace(entry) {
  try {
    mkdirSync(dirname(tracePath), { recursive: true });
    appendFileSync(tracePath, `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`);
  } catch {
    /* trace is diagnostic only */
  }
}

function readGuard() {
  try {
    const value = JSON.parse(readFileSync(guardPath, 'utf8'));
    return value !== null && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function guardKey(runId, stepId) {
  return `${runId}::${stepId}`;
}

function incrementGuard(key) {
  try {
    const guard = readGuard();
    guard[key] = (Number.isInteger(guard[key]) ? guard[key] : 0) + 1;
    mkdirSync(dirname(guardPath), { recursive: true });
    const temp = `${guardPath}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(guard)}\n`);
    renameSync(temp, guardPath);
  } catch {
    /* a broken guard file must not break the session */
  }
}

function deliver(text) {
  if (text === '') return;
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

function denyPayloadForDialect(payload, exitCode) {
  if (exitCode !== 2 || payload === null) return { payload, exitCode };
  const reason = typeof payload.reason === 'string'
    ? payload.reason
    : typeof payload.permissionDecisionReason === 'string'
      ? payload.permissionDecisionReason
      : 'denied by r2c guard';
  if (dialect === 'dsh') {
    return {
      exitCode: 0,
      payload: {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      },
    };
  }
  return { exitCode, payload };
}

async function runStop() {
  if (!sessionId) {
    appendTrace({ hook: 'stop', session_id: null, delivered: false, reason: 'no-session' });
    return;
  }
  if (stopHookActive) {
    appendTrace({ hook: 'stop', session_id: sessionId, delivered: false, reason: 'stop-hook-active' });
    return;
  }

  const status = await runner(argsFor('status', ['--json', '--session-id', sessionId, '--project-root', projectRoot]));
  let candidate = null;
  if (status.exitCode === 0) {
    const statusEnvelope = parseJson(status.stdout.trim());
    const runId = statusEnvelope?.data?.run?.run_id ?? null;
    const runStatus = statusEnvelope?.data?.run?.status ?? null;
    const stepId = statusEnvelope?.data?.next?.id ?? null;
    const stepStatus = statusEnvelope?.data?.next?.status ?? null;
    if (typeof runId === 'string' && runStatus === 'running' && typeof stepId === 'string' && stepStatus === 'active') {
      candidate = { runId, stepId, key: guardKey(runId, stepId) };
    }
  }

  if (candidate !== null && cap > 0 && (readGuard()[candidate.key] ?? 0) >= cap) {
    process.stderr.write(`[r2c] stop guard capped at ${cap} for ${candidate.runId}/${candidate.stepId}; run "r2c next --session-id ${sessionId}" manually.\n`);
    appendTrace({ hook: 'stop', session_id: sessionId, run_id: candidate.runId, step_id: candidate.stepId, delivered: false, capped: true });
    return;
  }

  const extra = ['--format', format, '--session-id', sessionId, '--project-root', projectRoot, '--runner-cmd', runnerCmd];
  if (workflow !== null) extra.push('--workflow', workflow);
  const result = await runner(argsFor('hook', ['stop', ...extra]), stdinText);
  if (result.exitCode !== 0) {
    appendTrace({ hook: 'stop', session_id: sessionId, run_id: candidate?.runId ?? null, step_id: candidate?.stepId ?? null, delivered: false, exit_code: result.exitCode });
    return;
  }
  const text = result.stdout.trimEnd();
  if (text === '') {
    appendTrace({ hook: 'stop', session_id: sessionId, run_id: candidate?.runId ?? null, step_id: candidate?.stepId ?? null, delivered: false, reason: 'empty' });
    return;
  }

  if (format === 'plain') {
    deliver(text);
  } else {
    const envelope = parseJson(text);
    if (envelope === null) {
      appendTrace({ hook: 'stop', session_id: sessionId, run_id: candidate?.runId ?? null, step_id: candidate?.stepId ?? null, delivered: false, reason: 'bad-json' });
      return;
    }
    deliver(JSON.stringify(envelope));
  }

  // A first stop claims a `cli-` run, so the run/step may only be known after
  // the delivery. Resolve it again and count the block under (run_id, step_id).
  if (candidate === null) {
    const after = await runner(argsFor('status', ['--json', '--session-id', sessionId, '--project-root', projectRoot]));
    if (after.exitCode === 0) {
      const envelope = parseJson(after.stdout.trim());
      const runId = envelope?.data?.run?.run_id ?? null;
      const stepId = envelope?.data?.next?.id ?? null;
      if (typeof runId === 'string' && typeof stepId === 'string') candidate = { runId, stepId, key: guardKey(runId, stepId) };
    }
  }
  if (candidate !== null) incrementGuard(candidate.key);
  writeUsageSnapshot({
    runId: candidate?.runId ?? null,
    transcriptPath: firstString(raw, ['transcript_path', 'transcriptPath']),
    model: firstString(raw, ['model']),
  });
  appendTrace({ hook: 'stop', session_id: sessionId, run_id: candidate?.runId ?? null, step_id: candidate?.stepId ?? null, delivered: true, capped: false });
}

/**
 * Append a cumulative usage snapshot (spec #7 §9.2). One line per stop event;
 * `token-usage` only ever reads the last line per (run_id, session_id), so this
 * must never be summed by anyone. Failures are silent and never change the
 * hook exit code.
 */
function writeUsageSnapshot({ runId, transcriptPath, model }) {
  if (typeof runId !== 'string' || typeof transcriptPath !== 'string' || transcriptPath === '') return;
  let usage = null;
  let detectedModel = model;
  try {
    const lines = readFileSync(transcriptPath, 'utf8').split(/\r?\n/).filter((line) => line.trim() !== '');
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      let entry;
      try {
        entry = JSON.parse(lines[index]);
      } catch {
        continue;
      }
      const candidate = entry?.message?.usage ?? entry?.usage ?? null;
      if (candidate !== null && typeof candidate === 'object') {
        usage = candidate;
        detectedModel = detectedModel ?? (typeof entry?.message?.model === 'string' ? entry.message.model : null);
        break;
      }
    }
  } catch {
    return;
  }
  if (usage === null) return;
  if (!AGENT_IDS.has(agentId)) return;
  const line = {
    schema: 'r2c.usage/v1',
    time: new Date().toISOString(),
    run_id: runId,
    session_id: sessionId,
    adapter: agentId,
    model: detectedModel ?? null,
    event: 'stop',
    cumulative: true,
    usage: {
      input_tokens: Number(usage.input_tokens ?? 0),
      output_tokens: Number(usage.output_tokens ?? 0),
      cache_read_tokens: Number(usage.cache_read_input_tokens ?? usage.cache_read_tokens ?? 0),
      cache_creation_tokens: Number(usage.cache_creation_input_tokens ?? usage.cache_creation_tokens ?? 0),
    },
    source: 'transcript',
  };
  try {
    const usageDir = join(projectRoot, '.r2c', 'usage');
    mkdirSync(usageDir, { recursive: true });
    appendFileSync(join(usageDir, `${runId}.jsonl`), `${JSON.stringify(line)}\n`);
  } catch {
    /* usage is best effort */
  }
}

async function runPreToolUse() {
  const result = await runner(
    argsFor('hook', ['pre-tool-use', '--project-root', projectRoot, ...(sessionId ? ['--session-id', sessionId] : [])]),
    stdinText,
  );
  const text = result.stdout.trim();
  const payload = text === '' ? null : parseJson(text);
  const translated = denyPayloadForDialect(payload, result.exitCode);
  appendTrace({
    hook: 'pre-tool-use',
    session_id: sessionId,
    delivered: translated.exitCode === 2,
    exit_code: translated.exitCode,
    reason: translated.payload?.reason ?? translated.payload?.hookSpecificOutput?.permissionDecisionReason ?? null,
    tool_name: firstString(raw, ['tool_name', 'toolName']),
  });
  if (translated.payload !== null) deliver(JSON.stringify(translated.payload));
  if (translated.exitCode !== 0) process.exitCode = translated.exitCode;
}

try {
  if (mode === 'stop') await runStop();
  else await runPreToolUse();
} catch (error) {
  try {
    appendTrace({ hook: mode, session_id: sessionId, delivered: false, reason: `error:${error?.message ?? 'unknown'}` });
  } catch {
    /* ignore */
  }
}
process.exit(process.exitCode ?? 0);
