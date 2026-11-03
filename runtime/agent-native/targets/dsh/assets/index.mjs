/**
 * Native DeepSeek Harness (dsh) plugin for hm2b.
 *
 * This is the A-档 carrier: it registers the human `/hm2b-*` commands, continues
 * a finished turn from `agent/turn-stopping`, and guards tool calls from
 * `tools/pre-execute`. Every seam delegates to the generic payload shim
 * (`shims/hook.mjs`), which already owns the 8-stop cap and the dsh deny
 * dialect. Nothing here may throw into the harness: every failure is a
 * `console.warn`, because an inactive plugin is only a warning in dsh and a
 * throwing listener can end a user's turn.
 *
 * The module has no imports outside Node core so it resolves from the payload
 * (`~/.hm2b/payload/<V>/adapters/dsh`) without a profile install step.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'hm2b-adapter-dsh';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PAYLOAD_HOME = resolve(HERE, '..', '..');

function warn(message) {
  try {
    console.warn(`[hm2b] ${message}`);
  } catch {
    // A broken console must not take the session down.
  }
}

function settingsOf(config = {}) {
  const payloadHome = typeof config.payloadHome === 'string' && config.payloadHome !== ''
    ? config.payloadHome
    : DEFAULT_PAYLOAD_HOME;
  const projectRoot = typeof config.projectRoot === 'string' && config.projectRoot !== ''
    ? config.projectRoot
    : process.cwd();
  const parsedCap = Number.parseInt(String(config.cap ?? 8), 10);
  return {
    runnerCmd: typeof config.runnerCmd === 'string' && config.runnerCmd !== ''
      ? config.runnerCmd
      : (process.env.HM2B_RUNNER_CMD ?? 'hm2b'),
    projectRoot,
    payloadHome,
    shim: typeof config.shim === 'string' && config.shim !== ''
      ? config.shim
      : join(payloadHome, 'shims', 'hook.mjs'),
    cap: Number.isFinite(parsedCap) && parsedCap >= 0 ? parsedCap : 8,
  };
}

function sessionIdOf(agent) {
  const value = agent?.session?.id;
  if (typeof value === 'string' && value !== '') return value;
  if (value !== undefined && value !== null) {
    try {
      const text = String(value);
      if (text !== '') return text;
    } catch {
      // fall through
    }
  }
  const fromEnv = process.env.DSH_SESSION_ID;
  return typeof fromEnv === 'string' && fromEnv !== '' ? fromEnv : null;
}

function parseJson(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/** Strip one matching pair of surrounding quotes; never any other parsing. */
function barePath(value) {
  const text = String(value).trim();
  if (text.length < 2) return text;
  const first = text[0];
  const last = text[text.length - 1];
  return (first === '"' || first === "'") && last === first ? text.slice(1, -1) : text;
}

/**
 * Resolve a runner command without a shell. Only `node <script>` and a single
 * `*.js`/`*.mjs`/`*.cjs` path are interpreted (both under process.execPath);
 * anything else is one executable path verbatim. Arguments are always passed
 * as separate argv entries, so invocation input never becomes shell syntax.
 */
function runnerInvocation(commandLine) {
  const text = commandLine.trim();
  const node = /^node(?:\.exe)?\s+([\s\S]+)$/i.exec(text);
  if (node !== null) {
    const script = barePath(node[1]);
    if (script !== '') return { file: process.execPath, prefix: [script] };
  }
  const single = barePath(text);
  if (/\.(?:c|m)?js$/i.test(single)) return { file: process.execPath, prefix: [single] };
  return { file: single, prefix: [] };
}

/** Run the runner directly, decoding stdout/stderr as UTF-8 buffers. */
function runCommand(commandLine, args, { input, cwd } = {}) {
  return new Promise((resolvePromise) => {
    const invocation = runnerInvocation(commandLine);
    let child;
    try {
      child = spawn(invocation.file, [...invocation.prefix, ...args], {
        shell: false,
        cwd,
        env: process.env,
        windowsHide: true,
      });
    } catch (error) {
      resolvePromise({ code: 1, stdout: '', stderr: error.message });
      return;
    }
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => {
      resolvePromise({ code: 1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: error.message });
    });
    child.on('close', (code) => {
      resolvePromise({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
    child.stdin.end(input ?? '');
  });
}

/** Spawn node directly so absolute shim paths and argv survive intact. */
function runNode(args, { input, cwd } = {}) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(process.execPath, args, { cwd, env: process.env, windowsHide: true });
    } catch (error) {
      resolvePromise({ code: 1, stdout: '', stderr: error.message });
      return;
    }
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => {
      resolvePromise({ code: 1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: error.message });
    });
    child.on('close', (code) => {
      resolvePromise({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
    child.stdin.end(input ?? '');
  });
}

function shimArgs(settings, event, sessionId) {
  const args = [
    settings.shim,
    '--agent', 'dsh',
    '--dialect', 'dsh',
    '--event', event,
    '--format', 'json',
    `--runner-cmd=${settings.runnerCmd}`,
    '--project-root', settings.projectRoot,
    '--plugin-data', join(settings.projectRoot, '.hm2b', 'runs', '.hooks'),
    '--cap', String(settings.cap),
  ];
  if (sessionId !== null) args.push('--session-id', sessionId);
  return args;
}

function commandDescription(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (match === null) return null;
  const line = match[1].split(/\r?\n/).find((entry) => /^description\s*:/.test(entry));
  return line === undefined ? null : line.slice(line.indexOf(':') + 1).trim().replace(/^["']|["']$/g, '');
}

function commandSpecs(payloadHome) {
  const dir = join(payloadHome, 'commands');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => /^hm2b-[a-z0-9_-]+\.md$/i.test(file))
    .sort()
    .map((file) => {
      let description = null;
      try {
        description = commandDescription(readFileSync(join(dir, file), 'utf8'));
      } catch {
        description = null;
      }
      return {
        name: basename(file).replace(/\.md$/, ''),
        description: description ?? `hm2b ${basename(file).replace(/\.md$/, '')}`,
      };
    });
}

function runnerArgsFor(command, rawInput) {
  const subcommand = command.replace(/^hm2b-/, '');
  if (subcommand === 'run') {
    const input = rawInput.trim();
    return input === '' ? ['run'] : ['run', '--input', input];
  }
  return [subcommand];
}

function makeUserMessage(text) {
  const block = Object.freeze({ type: 'text', text });
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([block]),
    source: Object.freeze({ kind: 'user' }),
  });
}

function registerCommands(ctx, settings) {
  let registry;
  try {
    registry = typeof ctx.get === 'function' ? ctx.get('commands') : ctx.commands;
  } catch {
    registry = undefined;
  }
  if (registry === undefined || registry === null || typeof registry.register !== 'function') {
    warn('commands service is unavailable; /hm2b-* commands were not registered');
    return;
  }
  for (const spec of commandSpecs(settings.payloadHome)) {
    try {
      registry.register({
        name: spec.name,
        description: spec.description,
        handler: async (invocation) => {
          try {
            const args = runnerArgsFor(spec.name, invocation?.rawInput ?? '');
            args.push('--project-root', settings.projectRoot);
            const sessionId = sessionIdOf(invocation?.agent);
            if (sessionId !== null) args.push('--session-id', sessionId);
            const result = await runCommand(settings.runnerCmd, args, { cwd: settings.projectRoot });
            const text = `${result.stdout}${result.stderr}`.trim();
            return {
              kind: result.code === 0 ? 'success' : 'error',
              text: text === '' ? `hm2b ${spec.name} exited ${result.code}` : text,
            };
          } catch (error) {
            warn(`/${spec.name} failed: ${error?.message ?? error}`);
            return { kind: 'error', text: `hm2b command failed: ${error?.message ?? error}` };
          }
        },
      });
    } catch (error) {
      warn(`cannot register /${spec.name}: ${error?.message ?? error}`);
    }
  }
}

async function handleTurnStopping(ctx, settings, payload) {
  try {
    const agent = payload?.agent;
    if (agent === undefined || agent === null) return;
    const sessionId = sessionIdOf(agent);
    const stdin = JSON.stringify({
      session_id: sessionId,
      cwd: settings.projectRoot,
      stop_hook_active: false,
    });
    const result = await runNode(shimArgs(settings, 'stop', sessionId), {
      input: stdin,
      cwd: settings.projectRoot,
    });
    const block = parseJson(result.stdout);
    if (block?.decision !== 'block' || typeof block.reason !== 'string' || block.reason.trim() === '') return;
    agent.steer(makeUserMessage(block.reason));
  } catch (error) {
    warn(`turn-stopping failed: ${error?.message ?? error}`);
  }
}

function denyFromShim(result) {
  const payload = parseJson(result.stdout);
  if (payload === null) return null;
  const hook = payload.hookSpecificOutput;
  if (hook?.permissionDecision === 'deny') {
    return typeof hook.permissionDecisionReason === 'string' && hook.permissionDecisionReason !== ''
      ? hook.permissionDecisionReason
      : 'denied by hm2b guard';
  }
  if (payload.permissionDecision === 'deny' && result.code === 2) {
    return typeof payload.reason === 'string' && payload.reason !== '' ? payload.reason : 'denied by hm2b guard';
  }
  return null;
}

async function handlePreExecute(settings, exec, next) {
  let decision = null;
  try {
    if (exec === undefined || exec === null || typeof exec.name !== 'string') return next();
    const sessionId = sessionIdOf(exec.agent);
    const stdin = JSON.stringify({
      session_id: sessionId,
      cwd: settings.projectRoot,
      stop_hook_active: false,
      tool_name: exec.name,
      tool_input: exec.arguments,
    });
    const result = await runNode(shimArgs(settings, 'pre-tool-use', sessionId), {
      input: stdin,
      cwd: settings.projectRoot,
    });
    const reason = denyFromShim(result);
    if (reason !== null) decision = { kind: 'deny', reason };
  } catch (error) {
    warn(`pre-execute failed: ${error?.message ?? error}`);
  }
  return decision ?? next();
}

/**
 * Cordis entry point.
 * @param ctx - plugin context (`on`, `get`).
 * @param config - rendered patch config: runnerCmd, projectRoot, payloadHome, shim, cap.
 */
export function apply(ctx, config) {
  const settings = settingsOf(config);
  try {
    registerCommands(ctx, settings);
  } catch (error) {
    warn(`command registration failed: ${error?.message ?? error}`);
  }
  try {
    ctx.on('agent/turn-stopping', (payload) => handleTurnStopping(ctx, settings, payload));
  } catch (error) {
    warn(`cannot subscribe to agent/turn-stopping: ${error?.message ?? error}`);
  }
  try {
    ctx.on('tools/pre-execute', (exec, next) => handlePreExecute(settings, exec, next));
  } catch (error) {
    warn(`cannot subscribe to tools/pre-execute: ${error?.message ?? error}`);
  }
}
