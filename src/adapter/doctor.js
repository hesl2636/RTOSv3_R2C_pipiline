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

function runAgentCommand(bin, args) {
  const extension = bin.slice(bin.lastIndexOf('.')).toLowerCase();
  const needsShell = process.platform === 'win32' && ['.cmd', '.bat'].includes(extension);
  const line = [bin, ...args].map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(' ');
  return spawnSync(needsShell ? line : bin, needsShell ? [] : args, {
    encoding: 'utf8',
    timeout: 60_000,
    shell: needsShell,
    windowsHide: true,
  });
}

const ACTIVATION_WARNING = /warning:\s+\d+\s+entr(?:y|ies)\s+did not activate/i;

function profileOf(receipt) {
  const profile = receipt.steps?.profile ?? null;
  if (profile === null || typeof profile !== 'object') return null;
  return typeof profile.name === 'string' && typeof profile.dir === 'string' ? profile : null;
}

/** Static fallback: the profile manifest still names our dependency and bundle. */
function profileManifestCheck(profile) {
  const manifestFile = join(profile.dir, 'package.json');
  if (!existsSync(manifestFile)) return `profile manifest missing: ${manifestFile}`;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  } catch (error) {
    return `profile manifest is not JSON: ${error.message}`;
  }
  const dependency = manifest?.dependencies?.['r2c-adapter-dsh'];
  if (typeof dependency !== 'string') return 'profile dependency r2c-adapter-dsh is missing';
  const bundles = manifest?.dsh?.profile?.bundles ?? [];
  if (!bundles.includes('r2c-adapter-dsh')) return 'profile bundle r2c-adapter-dsh is missing';
  return null;
}

/** Activation is observable only from dsh's composed config or boot diagnostics. */
function checkPluginActivated({ receipt, detection }) {
  const profile = profileOf(receipt);
  if (profile === null) {
    return check('plugin.activated', 'fail', 'receipt has no dsh profile record; reinstall the adapter');
  }
  const staticProblem = profileManifestCheck(profile);
  if (staticProblem !== null) return check('plugin.activated', 'fail', staticProblem);
  if (detection.bin === null) {
    return check('plugin.activated', 'warn', `dsh binary unavailable; profile ${profile.name} names the bundle but activation was not observed`);
  }
  const result = runAgentCommand(detection.bin, ['--profile', profile.name, '--dump-config']);
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (ACTIVATION_WARNING.test(output)) {
    const line = output.split(/\r?\n/).find((entry) => ACTIVATION_WARNING.test(entry)) ?? 'entry did not activate';
    return check('plugin.activated', 'fail', line.trim());
  }
  if (result.error) {
    return check('plugin.activated', 'fail', `dsh --dump-config could not run: ${result.error.message}`);
  }
  if (result.status !== 0) {
    return check(
      'plugin.activated',
      'fail',
      `dsh --dump-config exited ${result.status}: ${(result.stderr || '').trim().slice(0, 200)}`,
    );
  }
  if (!/r2c-adapter-dsh|r2c-dsh|adapters[\\/]dsh/.test(output)) {
    return check('plugin.activated', 'fail', `dsh --dump-config does not mention the r2c bundle (profile ${profile.name})`);
  }
  return check('plugin.activated', 'pass', `dsh --profile ${profile.name} --dump-config composed the r2c bundle`);
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
  if (detection.version === null || detection.version === undefined) {
    checks.push(check('agent.version', 'warn', 'agent version could not be determined'));
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
  if (carrier === null && agentId === 'dsh') {
    checks.push(check('hooks.wired', 'pass', 'native Cordis seams (agent/turn-stopping + tools/pre-execute)'));
  } else if (carrier === null) {
    checks.push(check('hooks.wired', 'pass', 'adapter declares no Stop carrier'));
  } else if (merged.length === 0) {
    checks.push(
      check('hooks.wired', 'warn', `hooks are declared (${carrier}) but this install does not wire them yet`),
    );
  } else {
    const carrierFile = join(scope === 'user' ? userHome() : ctx.projectRoot, ...carrier.split('/'));
    checks.push(
      existsSync(carrierFile)
        ? check('hooks.wired', 'pass', `${merged.length} merged entr(ies) in ${carrier}`)
        : check('hooks.wired', 'fail', `carrier missing: ${carrierFile}`),
    );
  }

  const shim = shimPath(receipt);
  const shouldSmoke = shim !== null && existsSync(shim) && (merged.length > 0 || agentId === 'dsh');
  if (!shouldSmoke) {
    checks.push(check('hooks.smoke', 'warn', 'no wired shim to smoke'));
  } else {
    const result = runShim(shim, agentId, { stdin: '{}' });
    checks.push(
      result.status === 0
        ? check('hooks.smoke', 'pass', 'shim exits 0 with empty stdin payload')
        : check('hooks.smoke', 'fail', `shim exited ${result.status}: ${(result.stderr || '').trim()}`),
    );
  }

  if (shim === null || !existsSync(shim)) {
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
    const probe = join(ctx.projectRoot, '.r2c', 'usage', `.doctor-probe-${process.pid}`);
    const script = [
      "const { mkdirSync, writeFileSync, unlinkSync } = require('node:fs');",
      `const file = ${JSON.stringify(probe)};`,
      "mkdirSync(require('node:path').dirname(file), { recursive: true });",
      "writeFileSync(file, 'probe');",
      'unlinkSync(file);',
    ].join(' ');
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: ctx.projectRoot,
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    });
    try {
      unlinkSync(probe);
    } catch {
      // absent is the normal case
    }
    checks.push(
      result.status === 0
        ? check('hooks.sandbox_write', 'pass', 'hook child process can write project .r2c')
        : check(
          'hooks.sandbox_write',
          'fail',
          `hook child process cannot write project .r2c: ${(result.stderr || '').trim().slice(0, 200)}`,
        ),
    );
  } else {
    checks.push(check('hooks.sandbox_write', 'warn', `not applicable to ${agentId}`));
  }

  if (agentId === 'dsh') {
    checks.push(checkPluginActivated({ receipt, detection }));
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
