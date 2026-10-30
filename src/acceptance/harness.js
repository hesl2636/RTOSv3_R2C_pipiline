/**
 * Acceptance harness: one temporary sandbox, fixture materialisation and the
 * only subprocess seam used by the checks.
 *
 * Every observation is made through the `r2c` executable, project files or the
 * hook shim. Nothing here imports a runner module, so the acceptance command
 * tests the shipped surface, not internal functions.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ACCEPTANCE_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(ACCEPTANCE_DIR, '..', '..');
export const BIN = join(REPO_ROOT, 'bin', 'r2c.js');
export const SHIM = join(REPO_ROOT, 'shims', 'hook.mjs');
export const FIXTURE_DIR = join(ACCEPTANCE_DIR, 'fixture');

export const SESSION = '01a181f0-00a9-7606-9db4-7eccaedcc245';
export const SESSION_2 = '01a181f0-00a9-7606-9db4-7eccaedcc246';
export const RUN_ID = /^R\d{8}T\d{6}Z-[0-9a-f]{6}$/;
export const CLI_SESSION = /^cli-R\d{8}T\d{6}Z-[0-9a-f]{6}$/;

/** The seven user-facing entry names every adapter must discover. */
export const COMMAND_IDS = Object.freeze([
  'r2c-run',
  'r2c-status',
  'r2c-pause',
  'r2c-resume',
  'r2c-cancel',
  'r2c-upload',
  'r2c-analysis',
]);

/** Agent binary name and version printed by the staged fake. */
export const FAKE_AGENTS = Object.freeze({
  'claude-code': { bin: 'claude', version: '2.1.312' },
  codex: { bin: 'codex', version: '0.165.0' },
  dsh: { bin: 'dsh', version: '0.2.1' },
  omp: { bin: 'omp', version: '18.13.2' },
  opencode: { bin: 'opencode', version: '1.19.5' },
});

/**
 * Stage a fake agent into `dir`. It prints the acceptance baseline version for
 * `--version`/`-V`, fails `plugin` (so the dsh installer takes its documented
 * manual merge path) and answers `--dump-config` for doctor activation. It
 * never reaches a network or a model.
 */
export function stageFakeAgent(dir, agentId) {
  const spec = FAKE_AGENTS[agentId];
  if (spec === undefined) return null;
  mkdirSync(dir, { recursive: true });
  const scriptName = `fake-${spec.bin}.mjs`;
  const script = join(dir, scriptName);
  writeFileSync(
    script,
    [
      "import { existsSync, readdirSync, readFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      'const args = process.argv.slice(2);',
      `const version = ${JSON.stringify(spec.version)};`,
      "if (args.includes('--dump-config')) { console.log('r2c-adapter-dsh'); process.exit(0); }",
      "if (args[0] === 'plugin') process.exit(1);",
      "if (args[0] === 'skill' && args[1] === 'list') {",
      "  const dir = join(process.cwd(), '.omp', 'skills');",
      '  const skills = [];',
      '  if (existsSync(dir)) {',
      '    for (const name of readdirSync(dir)) {',
      "      const file = join(dir, name, 'SKILL.md');",
      '      if (!existsSync(file)) continue;',
      "      const match = /^---\\r?\\n([\\s\\S]*?)\\r?\\n---/.exec(readFileSync(file, 'utf8'));",
      "      let description = '';",
      '      if (match) {',
      "        for (const line of match[1].split(/\\r?\\n/)) {",
      "          const index = line.indexOf(':');",
      "          if (index > 0 && line.slice(0, index).trim() === 'description') description = line.slice(index + 1).trim();",
      '        }',
      '      }',
      "      skills.push({ name, description: description || name });",
      '    }',
      '  }',
      '  console.log(JSON.stringify({ skills }));',
      '  process.exit(0);',
      '}',
      'console.log(version);',
      '',
    ].join('\n'),
  );
  if (process.platform === 'win32') {
    const wrapper = join(dir, `${spec.bin}.cmd`);
    writeFileSync(wrapper, `@echo off\r\nnode "%~dp0${scriptName}" %*\r\n`);
    return wrapper;
  }
  const file = join(dir, spec.bin);
  writeFileSync(file, `#!/usr/bin/env node\n${readFileSync(script, 'utf8')}`);
  chmodSync(file, 0o755);
  return file;
}

export function copyFixture(destination) {
  mkdirSync(join(destination, 'workflows'), { recursive: true });
  cpSync(join(FIXTURE_DIR, 'smoke.yaml'), join(destination, 'workflows', 'smoke.yaml'));
  cpSync(join(FIXTURE_DIR, 'tasks'), join(destination, 'tasks'), { recursive: true });
  cpSync(join(FIXTURE_DIR, 'gates'), join(destination, 'gates'), { recursive: true });
  return destination;
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function readJsonIfExists(file) {
  return existsSync(file) ? readJson(file) : null;
}

export function statePath(root, runId) {
  return join(root, '.r2c', 'runs', runId, 'state.json');
}

export function eventsPath(root, runId) {
  return join(root, '.r2c', 'runs', runId, 'events.jsonl');
}

export function latestPath(root) {
  return join(root, '.r2c', 'latest.json');
}

export function readState(root, runId) {
  return readJson(statePath(root, runId));
}

export function writeState(root, runId, state) {
  writeFileSync(statePath(root, runId), `${JSON.stringify(state, null, 2)}\n`);
}

export function readEvents(root, runId) {
  return readFileSync(eventsPath(root, runId), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

export function readLatest(root) {
  return readJson(latestPath(root));
}

/** Every file under `.r2c`, keyed by relative path, as raw base64 bytes. */
export function snapshotR2c(root) {
  const files = {};
  const base = join(root, '.r2c');
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      const file = join(dir, name);
      const info = statSync(file);
      if (info.isDirectory()) walk(file);
      else files[file.slice(base.length + 1)] = readFileSync(file).toString('base64');
    }
  };
  walk(base);
  return files;
}

/** The T2 normalization contract, in one place. */
const DROPPED_KEYS = new Set([
  'run_id',
  'session_id',
  'workflow_engine',
  'engine',
  'engine_version',
]);

export function normalizeState(state) {
  const walk = (value) => {
    if (Array.isArray(value)) return value.map(walk);
    if (value === null || typeof value !== 'object') return value;
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (DROPPED_KEYS.has(key) || key.endsWith('_at') || key.startsWith('trace_')) continue;
      out[key] = walk(child);
    }
    return out;
  };
  return walk(state);
}

/** Events with wall-clock time removed; everything else is contract. */
export function normalizeEvents(events) {
  return events.map((event) => {
    const { time: _time, ...rest } = event;
    return rest;
  });
}

export function claims(events) {
  return events.filter((event) => event.kind === 'run' && event.event === 'claimed');
}

/** Read PATH regardless of its Windows casing (`Path` is the common one). */
function inheritedPath(env) {
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'path') return env[key] ?? '';
  }
  return '';
}

function childEnvironment({ home, pathDir }) {
  const env = { ...process.env };
  for (const key of ['R2C_SESSION_ID', 'R2C_PROJECT_ROOT']) delete env[key];
  env.HOME = home;
  env.USERPROFILE = home;
  env.R2C_HOME = home;
  env.DSH_HOME = join(home, '.dsh');
  // Collapse `Path`/`PATH` into one entry. Leaving both makes Windows keep
  // only the value assigned here, which drops `node` and the system tools.
  const current = inheritedPath(env);
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'path') delete env[key];
  }
  env.PATH = pathDir === null || pathDir === undefined
    ? current
    : `${pathDir}${delimiter}${current}`;
  return env;
}

/** A transient spawn failure (resource pressure) must not fail a check. */
export function spawnSyncRetry(command, args, options, attempts = 3) {
  const transient = new Set(['EAGAIN', 'EMFILE', 'ENOMEM', 'EBUSY']);
  let result;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    result = spawnSync(command, args, options);
    if (result.error === undefined || !transient.has(result.error?.code)) return result;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * (attempt + 1));
  }
  return result;
}

/**
 * Create the one sandbox a single `r2c acceptance` run uses. `home` holds every
 * user-scope write; `project(id)` materialises a fresh fixture project.
 */
export function createHarness({ sandbox, pathDir = null, installRoot, version }) {
  const home = join(sandbox, 'home');
  mkdirSync(join(home, '.dsh'), { recursive: true });
  const env = childEnvironment({ home, pathDir });
  const base = { sandbox, home, env, pathDir, installRoot, version };

  const run = (args, options = {}) => spawnSyncRetry(process.execPath, [BIN, ...args], {
    cwd: options.cwd ?? sandbox,
    env: options.env === undefined ? env : { ...env, ...options.env },
    input: options.input,
    encoding: 'utf8',
    timeout: options.timeout ?? 120_000,
    windowsHide: true,
  });

  const runAsync = (args, options = {}) => new Promise((settle) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: options.cwd ?? sandbox,
      env: options.env === undefined ? env : { ...env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => settle({ status, stdout, stderr }));
    child.on('error', (error) => settle({ status: null, stdout, stderr, error }));
  });

  let projectCount = 0;
  const project = (label, { fixture = true } = {}) => {
    projectCount += 1;
    const root = join(sandbox, 'projects', `${String(projectCount).padStart(2, '0')}-${label}`);
    mkdirSync(root, { recursive: true });
    if (fixture) copyFixture(root);
    return root;
  };

  return {
    ...base,
    run,
    runAsync,
    project,
    /** Run the hook shim with a raw stdin payload. */
    shim(args, { cwd, input } = {}) {
      return spawnSyncRetry(process.execPath, [SHIM, ...args], {
        cwd: cwd ?? sandbox,
        env,
        input,
        encoding: 'utf8',
        timeout: 120_000,
        windowsHide: true,
      });
    },
  };
}

/** One JSON envelope line, or a concise failure carrying both streams. */
export function envelope(result, label) {
  const lines = result.stdout.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length !== 1) {
    throw new Error(
      `${label}: expected one JSON line, got ${JSON.stringify(result.stdout)} / ${result.stderr}`,
    );
  }
  try {
    return JSON.parse(lines[0]);
  } catch (error) {
    throw new Error(`${label}: invalid JSON (${error.message}): ${lines[0]}`);
  }
}

export function submitLine(output) {
  return output.split(/\r?\n/).find((line) => line.includes(' submit --session-id ')) ?? '';
}

/** Create `<project>/artifacts/<name>` as the stand-in for model output. */
export function artifact(root, name) {
  mkdirSync(join(root, 'artifacts'), { recursive: true });
  writeFileSync(join(root, 'artifacts', name), `acceptance ${name}\n`);
}

export function tempSandbox() {
  return mkdtempSync(join(tmpdir(), 'r2c-acceptance-'));
}
