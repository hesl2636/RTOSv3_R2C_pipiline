/**
 * `r2c acceptance`: the zero-model aggregator.
 *
 * The command opens one sandbox, redirects HOME/USERPROFILE/R2C_HOME/DSH_HOME
 * into it, runs every check through the shipped executable, and reports a
 * single-line envelope. It never calls a model and never reads a secret.
 *
 * Faces:
 *   no --agent  -> 17 checks: E0 V1 FS1 FS3' FS4 T2 T4 + SB1..SB10
 *   --agent <a> -> 15 checks: the same 7 engine checks + I1 I2 I3 I4 I5 T1 U1 U2
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_CODES, R2cError } from '../errors.js';
import {
  BIN,
  REPO_ROOT,
  createHarness,
  stageFakeAgent,
  tempSandbox,
} from './harness.js';
import {
  CheckError,
  agentChecks,
  allCheckIds,
  coreChecks,
  engineChecks,
} from './checks.js';

function usage(message, details = null) {
  return new R2cError('USAGE', message, details, EXIT_CODES.USAGE);
}

/** The source checkout doubles as a payload; an installed package needs env. */
function payloadSource() {
  const configured = process.env.R2C_PLUGIN_SOURCE;
  if (typeof configured === 'string' && configured !== '') return configured;
  if (existsSync(join(REPO_ROOT, 'adapters')) && existsSync(join(REPO_ROOT, 'pack'))) {
    return REPO_ROOT;
  }
  return null;
}

function adapterIds(source) {
  const root = source === null ? join(REPO_ROOT, 'adapters') : join(source, 'adapters');
  if (!existsSync(root)) return null;
  const ids = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (existsSync(join(root, entry.name, 'adapter.json'))) ids.push(entry.name);
  }
  return ids.sort();
}

async function execute(check) {
  try {
    const result = await check.run();
    return {
      id: check.id,
      status: result?.status ?? 'pass',
      detail: result?.detail ?? '',
      exitCode: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      id: check.id,
      status: 'fail',
      detail: message.length > 500 ? `${message.slice(0, 497)}...` : message,
      exitCode: error instanceof CheckError ? error.exitCode : null,
    };
  }
}

function summarize(results) {
  const summary = { pass: 0, warn: 0, fail: 0 };
  for (const result of results) {
    if (result.status === 'pass') summary.pass += 1;
    else if (result.status === 'warn') summary.warn += 1;
    else summary.fail += 1;
  }
  return summary;
}

function report({ results, summary, engine, agent, project, tempDir }) {
  return {
    engine,
    agent,
    project,
    checks: results.map(({ id, status, detail }) => ({ id, status, detail })),
    summary,
    ...(tempDir === null ? {} : { temp_dir: tempDir }),
  };
}

function emitText(data) {
  for (const check of data.checks) {
    process.stdout.write(`${check.status.toUpperCase().padEnd(4)} ${check.id} ${check.detail}\n`);
  }
  process.stderr.write(
    `acceptance: ${data.summary.pass} pass, ${data.summary.warn} warn, ${data.summary.fail} fail\n`,
  );
  if (data.temp_dir !== undefined) process.stdout.write(`kept: ${data.temp_dir}\n`);
  for (const check of data.checks) {
    if (check.status === 'fail') process.stderr.write(`FAIL ${check.id}: ${check.detail}\n`);
  }
}

function selectedChecks({ checks, requested }) {
  if (requested === null) return checks;
  const available = new Map(checks.map((check) => [check.id, check]));
  const ordered = [];
  for (const id of allCheckIds()) {
    if (requested.has(id) && available.has(id)) ordered.push(available.get(id));
  }
  for (const id of requested) {
    if (!available.has(id)) throw usage(`unknown acceptance check: ${id}`, { check: id });
  }
  return ordered;
}

export async function runAcceptance(_argv, ctx) {
  const options = ctx.options ?? {};
  const requestedAgent = typeof options.agent === 'string' && options.agent !== '' ? options.agent : null;
  const keep = options.keep === true;
  const only = typeof options.only === 'string' && options.only.trim() !== ''
    ? new Set(options.only.split(',').map((id) => id.trim()).filter(Boolean))
    : null;
  if (_argv.length > 0) {
    throw usage(`acceptance takes no positional arguments: ${_argv.join(' ')}`);
  }

  const source = payloadSource();
  if (requestedAgent !== null) {
    const ids = adapterIds(source);
    if (ids !== null && !ids.includes(requestedAgent)) {
      throw new R2cError(
        'AGENT_NOT_FOUND',
        `agent is not installed or not declared: ${requestedAgent}`,
        { agent: requestedAgent, available: ids },
        EXIT_CODES.NO_ACTIVE_RUN,
      );
    }
  }
  if (requestedAgent !== null && source === null) {
    throw new R2cError(
      'PAYLOAD_NOT_FOUND',
      'no plugin payload source is available; set R2C_PLUGIN_SOURCE to a payload',
      { adapter: requestedAgent },
      EXIT_CODES.NO_ACTIVE_RUN,
    );
  }

  const sandbox = tempSandbox();
  const explicitProject = (options.provided ?? []).some(
    (option) => option === '--project-root' || option === '--project',
  ) || (typeof process.env.R2C_PROJECT_ROOT === 'string' && process.env.R2C_PROJECT_ROOT !== '');
  const installRoot = explicitProject ? ctx.projectRoot : join(sandbox, 'project');
  mkdirSync(installRoot, { recursive: true });
  const fakeBin = join(sandbox, 'bin');
  if (requestedAgent !== null) stageFakeAgent(fakeBin, requestedAgent);

  const h = createHarness({
    sandbox,
    pathDir: requestedAgent === null ? null : fakeBin,
    installRoot,
    version: ctx.version,
  });

  const allEngine = engineChecks(h);
  const agent = requestedAgent === null ? [] : agentChecks(h, requestedAgent, source);
  let checks;
  if (only === null) {
    checks = requestedAgent === null ? allEngine : [...coreChecks(h), ...agent];
  } else {
    const all = [...allEngine, ...agent];
    const known = new Set(all.map((check) => check.id));
    for (const id of only) {
      if (!known.has(id)) {
        if (allCheckIds().includes(id)) {
          throw usage(`check ${id} needs --agent <id>`, { check: id });
        }
        throw usage(`unknown acceptance check: ${id}`, { check: id });
      }
    }
    checks = selectedChecks({ checks: all, requested: only });
  }

  const results = new Map();
  let lockConflict = false;
  try {
    if (requestedAgent !== null && only === null) {
      const preInstalled = [
        join(installRoot, '.r2c', 'install', `${requestedAgent}.json`),
        join(h.home, '.r2c', 'install', `${requestedAgent}.json`),
      ].some((file) => existsSync(file));
      const byId = new Map(checks.map((check) => [check.id, check]));
      if (preInstalled) {
        const doctor = await execute(byId.get('I3'));
        results.set('I3', doctor);
        if (doctor.exitCode === 5) lockConflict = true;
      }
      for (const check of checks) {
        if (check.id === 'I3' && preInstalled) continue;
        const result = await execute(check);
        results.set(result.id, result);
        if (result.exitCode === 5) lockConflict = true;
      }
    } else {
      for (const check of checks) {
        const result = await execute(check);
        results.set(result.id, result);
        if (result.exitCode === 5) lockConflict = true;
      }
    }
  } finally {
    if (!keep) rmSync(sandbox, { recursive: true, force: true });
  }

  const ordered = checks
    .map((check) => results.get(check.id))
    .filter((result) => result !== undefined);
  const summary = summarize(ordered);
  const data = report({
    results: ordered,
    summary,
    engine: { version: ctx.version, node: process.versions.node },
    agent: requestedAgent,
    project: installRoot,
    tempDir: keep ? sandbox : null,
  });
  const sessionId = `acc-${randomBytes(4).toString('hex')}`;

  if (!ctx.json) emitText(data);

  if (lockConflict) {
    throw new R2cError(
      'LOCK_CONFLICT',
      'acceptance hit a held install lock',
      { lock: true },
      EXIT_CODES.LOCK,
      data,
    );
  }
  const missing = ordered.find(
    (result) => result.exitCode === EXIT_CODES.NO_ACTIVE_RUN && result.id.startsWith('I'),
  );
  if (missing !== undefined) {
    throw new R2cError(
      'NOT_INSTALLED',
      `acceptance could not install the agent: ${missing.detail}`,
      { check: missing.id },
      EXIT_CODES.NO_ACTIVE_RUN,
      data,
    );
  }
  if (summary.fail > 0) {
    throw new R2cError(
      'ACCEPTANCE_FAILED',
      `${summary.fail} acceptance check(s) failed: ${ordered.filter((r) => r.status === 'fail').map((r) => r.id).join(', ')}`,
      null,
      EXIT_CODES.GATE,
      data,
    );
  }
  return { command: 'acceptance', sessionId, data };
}
