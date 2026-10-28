/**
 * `adapter doctor`: receipt + discovery health, exit 0/3/4.
 *
 * Checks use only local bytes and zero model calls. A missing receipt is exit 4
 * before any check runs; after that every check reports `pass|warn|fail` and
 * one `fail` makes the command exit 3.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_CODES, R2cError } from '../errors.js';
import { isValidRange, satisfies } from '../version.js';
import { detectAgent } from './detect.js';
import { runAdapterSmoke } from './smoke.js';
import { receiptPath, stateDir } from './state.js';
import { isFile, isLink, linkTarget, readJsonIfExists, sha256File, userHome } from './util.js';

function check(name, status, detail) {
  return { name, status, detail };
}

function readInstalledAdapter(receipt) {
  if (!receipt.payload_home) return null;
  const file = join(receipt.payload_home, 'adapters', receipt.adapter, 'adapter.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function verifyFiles(receipt) {
  const problems = [];
  let verified = 0;
  for (const file of receipt.files ?? []) {
    if (!existsSync(file.path)) {
      problems.push(`missing:${file.path}`);
      continue;
    }
    if (file.kind === 'link') {
      if (!isLink(file.path)) {
        problems.push(`not-a-link:${file.path}`);
      } else if (!existsSync(linkTarget(file.path) ?? file.target ?? '')) {
        problems.push(`broken-link:${file.path}`);
      } else {
        verified += 1;
      }
      continue;
    }
    if (!isFile(file.path)) {
      problems.push(`not-a-file:${file.path}`);
      continue;
    }
    if (sha256File(file.path) !== file.sha256) {
      problems.push(`hash-mismatch:${file.path}`);
    } else {
      verified += 1;
    }
  }
  return { problems, verified };
}

function carrierMerged(receipt, carrier) {
  const suffix = carrier.replaceAll('\\', '/');
  return (receipt.merged ?? []).filter((entry) =>
    entry.file.replaceAll('\\', '/').endsWith(suffix),
  );
}

function shimPath(receipt) {
  return receipt.payload_home ? join(receipt.payload_home, 'shims', 'hook.mjs') : null;
}

function runShim(shim, agentId, { stdin } = {}) {
  return spawnSync(process.execPath, [shim, '--agent', agentId, '--event', 'stop', '--format', 'json'], {
    encoding: 'utf8',
    timeout: 30_000,
    input: stdin ?? '',
  });
}

function pathKey(path) {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

function carrierFile(adapter, scope, projectRoot) {
  const carrier = adapter?.hooks?.stop?.carrier ?? null;
  if (carrier === null) return null;
  const root = scope === 'user' ? userHome() : projectRoot;
  return join(root, ...carrier.split('/'));
}

function readCarrierHandlers(file) {
  if (file === null || !existsSync(file)) return { document: null, handlers: [] };
  let document;
  try {
    document = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { document: null, handlers: [], invalid: true };
  }
  const handlers = [];
  for (const event of ['Stop', 'PreToolUse']) {
    for (const group of document?.hooks?.[event] ?? []) {
      for (const handler of group?.hooks ?? []) {
        if (handler !== null && typeof handler === 'object') handlers.push({ event, handler });
      }
    }
  }
  return { document, handlers };
}

/**
 * Run one configured hook command the way the agent will. On Windows the
 * adapter renders a `.cmd` launcher and names it in `commandWindows`; the path
 * stays unquoted here because the .cmd quotes node/shim internally and codex
 * must not receive a quoted argument list.
 */
function runConfiguredHook(handler, cwd) {
  const command = process.platform === 'win32'
    ? handler.commandWindows ?? handler.command
    : handler.command ?? handler.commandWindows;
  if (typeof command !== 'string' || command === '') {
    return { error: new Error('hook handler has no command'), status: null };
  }
  const isWin = process.platform === 'win32';
  const shell = isWin ? process.env.ComSpec || 'cmd.exe' : '/bin/sh';
  return spawnSync(shell, isWin ? ['/d', '/c', command] : ['-c', command], {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    input: '{}',
    windowsHide: true,
  });
}

/** Hook-shaped child: same payload/cwd/env a real hook receives. */
function probeHookSandboxWrite(projectRoot) {
  const probe = join(projectRoot, '.r2c', `.doctor-probe-${process.pid}-${Date.now()}`);
  const script = [
    "const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');",
    "const { dirname } = require('node:path');",
    "const input = JSON.parse(readFileSync(0, 'utf8') || '{}');",
    "const target = input.tool_input && input.tool_input.file_path;",
    'if (typeof target !== "string" || target === "") process.exit(3);',
    'mkdirSync(dirname(target), { recursive: true });',
    "writeFileSync(target, 'probe');",
  ].join('\n');
  const payload = {
    session_id: `doctor-${process.pid}`,
    cwd: projectRoot,
    hook_event_name: 'PreToolUse',
    tool_name: 'write',
    tool_input: { file_path: probe },
  };
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 15_000,
    input: JSON.stringify(payload),
    windowsHide: true,
  });
  let written = false;
  try {
    written = readFileSync(probe, 'utf8') === 'probe';
    unlinkSync(probe);
  } catch {
    written = false;
  }
  return { ok: result.status === 0 && written, result, probe };
}

export function doctorAdapter({ ctx, agentId, options }) {
  const requested = options.scope ?? null;
  let scope = requested;
  if (scope === null) {
    scope = readJsonIfExists(receiptPath(stateDir('project', ctx.projectRoot), agentId)) !== null
      ? 'project'
      : 'user';
  }
  const state = stateDir(scope, ctx.projectRoot);
  const receipt = readJsonIfExists(receiptPath(state, agentId));
  const checks = [];

  if (receipt === null) {
    checks.push(check('receipt.present', 'fail', `no receipt at ${receiptPath(state, agentId)}`));
    throw new R2cError(
      'NOT_INSTALLED',
      `adapter ${agentId} is not installed (${scope} scope)`,
      { adapter: agentId, scope, checks },
      EXIT_CODES.NO_ACTIVE_RUN,
      { adapter: agentId, scope, checks },
    );
  }
  checks.push(check('receipt.present', 'pass', `${scope} receipt found`));

  const adapter = readInstalledAdapter(receipt);
  const detection = detectAgent(adapter?.detect ?? {});
  if (detection.detected) {
    checks.push(check('agent.detected', 'pass', detection.bin ?? detection.paths.find((entry) => entry.present)?.path ?? 'detected'));
  } else {
    checks.push(check('agent.detected', 'fail', 'agent executable and configured paths were not found'));
  }

  const agentRange = receipt.requires?.agent ?? adapter?.requires?.agent ?? null;
  const warnPrefix = adapter?.options?.warnVersionPrefix;
  if (detection.version === null || detection.version === undefined) {
    checks.push(check('agent.version', 'warn', 'agent version could not be determined'));
  } else if (typeof warnPrefix === 'string' && warnPrefix !== '' && detection.version.startsWith(warnPrefix)) {
    checks.push(
      check(
        'agent.version',
        'warn',
        `${detection.version}: ${adapter?.options?.warnVersionDetail ?? 'this build is not an acceptance baseline'}`,
      ),
    );
  } else if (agentRange !== null && isValidRange(agentRange) && !satisfies(detection.version, agentRange)) {
    checks.push(check('agent.version', 'warn', `${detection.version} is outside ${agentRange}`));
  } else {
    checks.push(check('agent.version', 'pass', detection.version));
  }

  const engineRange = receipt.engine?.requires ?? receipt.requires?.engine ?? adapter?.requires?.engine ?? null;
  if (engineRange === null) {
    checks.push(check('engine.version', 'warn', 'receipt does not pin an engine range'));
  } else if (!isValidRange(engineRange)) {
    checks.push(check('engine.version', 'fail', `invalid engine range: ${engineRange}`));
  } else if (!satisfies(ctx.version, engineRange)) {
    checks.push(check('engine.version', 'fail', `engine ${ctx.version} is outside ${engineRange}`));
  } else {
    checks.push(check('engine.version', 'pass', `engine ${ctx.version} satisfies ${engineRange}`));
  }

  const files = verifyFiles(receipt);
  if (files.problems.length > 0) {
    checks.push(
      check(
        'receipt.files',
        'fail',
        `${files.problems.length} file(s) differ: ${files.problems.slice(0, 4).join(', ')}; re-run install --force to repair`,
      ),
    );
  } else {
    checks.push(check('receipt.files', 'pass', `${files.verified} file(s) match the receipt`));
  }

  const carrier = adapter?.hooks?.stop?.carrier ?? null;
  const merged = carrier === null ? [] : carrierMerged(receipt, carrier);
  const carrierPath = carrierFile(adapter, scope, ctx.projectRoot);
  const renderedCarrier = carrierPath !== null
    && (receipt.files ?? []).some((file) => pathKey(file.path) === pathKey(carrierPath));
  const carrierState = readCarrierHandlers(carrierPath);
  const wired = carrier !== null && (merged.length > 0 || renderedCarrier);
  if (carrier === null) {
    checks.push(check('hooks.wired', 'pass', 'adapter declares no Stop carrier'));
  } else if (!wired) {
    checks.push(
      check('hooks.wired', 'warn', `hooks are declared (${carrier}) but this install does not wire them yet`),
    );
  } else if (!existsSync(carrierPath)) {
    checks.push(check('hooks.wired', 'fail', `carrier missing: ${carrierPath}`));
  } else if (carrierState.invalid === true) {
    checks.push(check('hooks.wired', 'fail', `carrier is not valid JSON: ${carrierPath}`));
  } else if (carrierState.handlers.length === 0) {
    checks.push(check('hooks.wired', 'fail', `carrier has no Stop/PreToolUse handlers: ${carrierPath}`));
  } else {
    checks.push(
      check(
        'hooks.wired',
        'pass',
        `${carrierState.handlers.length} hook handler(s) in ${carrier}`,
      ),
    );
  }

  const shim = shimPath(receipt);
  if (!wired || shim === null || !existsSync(shim)) {
    checks.push(check('hooks.smoke', 'warn', 'no wired shim to smoke'));
  } else {
    const result = runShim(shim, agentId, { stdin: '{}' });
    checks.push(
      result.status === 0
        ? check('hooks.smoke', 'pass', 'shim exits 0 with empty stdin payload')
        : check('hooks.smoke', 'fail', `shim exited ${result.status}: ${(result.stderr || '').trim()}`),
    );
  }

  if (!wired) {
    checks.push(check('hooks.launch', 'warn', 'no wired hook carrier to launch'));
  } else if (carrierState.handlers.length > 0) {
    const stop = carrierState.handlers.find((entry) => entry.event === 'Stop') ?? carrierState.handlers[0];
    const result = runConfiguredHook(stop.handler, ctx.projectRoot);
    checks.push(
      result.error
        ? check('hooks.launch', 'fail', `configured hook could not be launched: ${result.error.message}`)
        : result.status === 0
          ? check('hooks.launch', 'pass', `${stop.event} launch command exited 0`)
          : check(
            'hooks.launch',
            'fail',
            `${stop.event} launch command exited ${result.status ?? 'signal'}: ${(result.stderr || '').trim()}`,
          ),
    );
  } else if (shim === null || !existsSync(shim)) {
    checks.push(check('hooks.launch', 'warn', 'payload has no shims/hook.mjs yet'));
  } else {
    const result = runShim(shim, agentId, { stdin: '' });
    checks.push(
      result.error
        ? check('hooks.launch', 'fail', `shim could not be launched: ${result.error.message}`)
        : check('hooks.launch', 'pass', `shim launched (exit ${result.status})`),
    );
  }

  if (['dsh', 'codex'].includes(agentId)) {
    const probe = probeHookSandboxWrite(ctx.projectRoot);
    checks.push(
      probe.ok
        ? check('hooks.sandbox_write', 'pass', 'hook-shaped subprocess wrote project .r2c')
        : check(
          'hooks.sandbox_write',
          'fail',
          `hook-shaped subprocess could not write project .r2c: exit ${probe.result.status ?? 'signal'} ${(probe.result.stderr || '').trim()}`.trim(),
        ),
    );
  } else {
    checks.push(check('hooks.sandbox_write', 'warn', `not applicable to ${agentId}`));
  }

  if (agentId === 'dsh') {
    checks.push(
      receipt.plugin_activated === true
        ? check('plugin.activated', 'pass', 'dsh bundle reported active')
        : check('plugin.activated', 'fail', 'dsh bundle is not reported active'),
    );
  } else {
    checks.push(check('plugin.activated', 'warn', `not applicable to ${agentId}`));
  }

  const smoke = runAdapterSmoke({
    payloadHome: receipt.payload_home,
    agentId,
    scope,
    projectRoot: ctx.projectRoot,
  });
  if (!smoke.available) {
    checks.push(check('discovery', 'warn', smoke.detail));
  } else if (smoke.ok) {
    checks.push(
      check(
        'discovery',
        'pass',
        `r2c-* commands/skills found${smoke.result?.found ? ` (${JSON.stringify(smoke.result.found)})` : ''}`,
      ),
    );
  } else {
    checks.push(check('discovery', 'fail', smoke.detail ?? 'smoke.mjs failed'));
  }

  const manualSteps = adapter?.manualSteps ?? receipt.manual ?? [];
  checks.push(
    manualSteps.length === 0
      ? check('manual', 'pass', 'no manual steps declared')
      : check('manual', 'warn', manualSteps.join('; ')),
  );

  const otherScope = scope === 'project' ? 'user' : 'project';
  const otherReceipt = readJsonIfExists(receiptPath(stateDir(otherScope, ctx.projectRoot), agentId));
  if (otherReceipt !== null && otherReceipt.payload?.version !== receipt.payload?.version) {
    checks.push(
      check(
        'scope.conflict',
        'warn',
        `another scope pins payload ${otherReceipt.payload?.version}, this one ${receipt.payload?.version}`,
      ),
    );
  } else {
    checks.push(check('scope.conflict', 'pass', otherReceipt === null ? 'single scope' : 'scopes agree'));
  }

  const failures = checks.filter((entry) => entry.status === 'fail');
  const data = {
    adapter: agentId,
    scope,
    payload_home: receipt.payload_home,
    healthy: failures.length === 0,
    checks,
  };
  if (failures.length > 0) {
    throw new R2cError(
      'DOCTOR_FAILED',
      `${failures.length} doctor check(s) failed: ${failures.map((entry) => entry.name).join(', ')}`,
      { adapter: agentId, checks },
      EXIT_CODES.GATE,
      data,
    );
  }
  return { command: 'adapter.doctor', data };
}
