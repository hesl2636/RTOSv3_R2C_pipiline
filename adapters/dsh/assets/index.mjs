/**
 * Native DeepSeek Harness (dsh) plugin for r2c.
 *
 * This is the A-档 carrier: it registers the human `/r2c-*` commands, continues
 * a finished turn from `agent/turn-stopping`, and guards tool calls from
 * `tools/pre-execute`. Every seam delegates to the generic payload shim
 * (`shims/hook.mjs`), which already owns the 8-stop cap and the dsh deny
 * dialect. Nothing here may throw into the harness: every failure is a
 * `console.warn`, because an inactive plugin is only a warning in dsh and a
 * throwing listener can end a user's turn.
 *
 * The module has no imports outside Node core so it resolves from the payload
 * (`~/.r2c/payload/<V>/adapters/dsh`) without a profile install step.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'r2c-adapter-dsh';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PAYLOAD_HOME = resolve(HERE, '..', '..');

function warn(message) {
  try {
    console.warn(`[r2c] ${message}`);
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
      : (process.env.R2C_RUNNER_CMD ?? 'r2c'),
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

function quote(value) {
  return `"${String(value).split('"').join('\\"')}"`;
}

/** Run a command line through the shell, decoding stdout/stderr as UTF-8 buffers. */
function runShell(commandLine, args, { input, cwd } = {}) {
  return new Promise((resolvePromise) => {
    const line = [commandLine, ...args.map(quote)].join(' ');
    let child;
    try {
      child = spawn(line, { shell: true, cwd, env: process.env, windowsHide: true });
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
    '--plugin-data', join(settings.projectRoot, '.r2c', 'runs', '.hooks'),
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
    .filter((file) => /^r2c-[a-z0-9_-]+\.md$/i.test(file))
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
        description: description ?? `r2c ${basename(file).replace(/\.md$/, '')}`,
      };
    });
}

function runnerArgsFor(command, rawInput) {
  const subcommand = command.replace(/^r2c-/, '');
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
    warn('commands service is unavailable; /r2c-* commands were not registered');
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
            const result = await runShell(settings.runnerCmd, args, { cwd: settings.projectRoot });
            const text = `${result.stdout}${result.stderr}`.trim();
            return {
              kind: result.code === 0 ? 'success' : 'error',
              text: text === '' ? `r2c ${spec.name} exited ${result.code}` : text,
            };
          } catch (error) {
            warn(`/${spec.name} failed: ${error?.message ?? error}`);
            return { kind: 'error', text: `r2c command failed: ${error?.message ?? error}` };
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
      : 'denied by r2c guard';
  }
  if (payload.permissionDecision === 'deny' && result.code === 2) {
    return typeof payload.reason === 'string' && payload.reason !== '' ? payload.reason : 'denied by r2c guard';
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
