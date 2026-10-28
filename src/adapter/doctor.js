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

function shimPath(receipt) {
  return receipt.payload_home ? join(receipt.payload_home, 'shims', 'hook.mjs') : null;
}

/** Declaration key → Claude-style settings event key. */
const HOOK_EVENTS = [
  ['stop', 'Stop'],
  ['preToolUse', 'PreToolUse'],
];

function declaredHooks(adapter) {
  const hooks = adapter?.hooks ?? {};
  const declared = [];
  for (const [key, event] of HOOK_EVENTS) {
    const carrier = hooks[key]?.carrier;
    if (typeof carrier === 'string' && carrier !== '') declared.push({ event, carrier });
  }
  return declared;
}

/** Every command string nested under one settings event array. */
function hookCommands(node) {
  const commands = [];
  const walk = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    for (const field of ['command', 'commandWindows']) {
      if (typeof value[field] === 'string') commands.push(value[field]);
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== 'command' && key !== 'commandWindows') walk(child);
    }
  };
  walk(node);
  return commands;
}

function eventCommands(document, event) {
  const node = document?.hooks?.[event];
  return node === undefined ? [] : hookCommands(node);
}

function usesShim(command, shim) {
  const comparable = (value) =>
    (process.platform === 'win32' ? value.toLowerCase() : value).replaceAll('\\', '/');
  return comparable(command).includes(comparable(shim));
}

/**
 * Launch commands for one event, platform-selected and filtered to handlers
 * that reference this shim. `commandWindows` wins on Windows; a handler whose
 * `commandWindows` is a rendered `.cmd` still qualifies through its sibling
 * `command` (the .cmd itself quotes node/shim internally).
 */
function eventLaunchCommands(document, event, shim) {
  const node = document?.hooks?.[event];
  if (node === undefined) return [];
  const commands = [];
  const walk = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    const fields = [value.command, value.commandWindows].filter((field) => typeof field === 'string');
    if (fields.some((field) => usesShim(field, shim))) {
      const chosen = process.platform === 'win32'
        ? value.commandWindows ?? value.command
        : value.command ?? value.commandWindows;
      if (typeof chosen === 'string') commands.push(chosen);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== 'command' && key !== 'commandWindows') walk(child);
    }
  };
  walk(node);
  return commands;
}

function readCarrierFile(file) {
  if (!existsSync(file)) return { ok: false, detail: `carrier missing: ${file}` };
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    return { ok: false, detail: `carrier is unreadable: ${file}: ${error.message}` };
  }
  // Some agents load native hook modules instead of settings JSON (omp). The
  // carrier still has to reference the shim and launch cleanly.
  if (/\.(?:[cm]?[jt]s)$/i.test(file)) {
    if (text.trim() === '') return { ok: false, detail: `carrier is empty: ${file}` };
    return { ok: true, module: true, text, document: null };
  }
  try {
    const document = JSON.parse(text);
    if (document === null || typeof document !== 'object' || Array.isArray(document)) {
      return { ok: false, detail: `carrier is not a JSON object: ${file}` };
    }
    return { ok: true, document };
  } catch (error) {
    return { ok: false, detail: `carrier is not valid JSON: ${file}: ${error.message}` };
  }
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

  const declared = declaredHooks(adapter);
  const shim = shimPath(receipt);
  const shimPresent = shim !== null && existsSync(shim);
  const carrierRoot = scope === 'user' ? userHome() : ctx.projectRoot;
  const carriers = new Map();
  for (const entry of declared) {
    const file = join(carrierRoot, ...entry.carrier.split('/'));
    if (!carriers.has(file)) carriers.set(file, readCarrierFile(file));
  }
  const carrierProblems = [...carriers.entries()]
    .filter(([, state]) => !state.ok)
    .map(([file, state]) => state.detail ?? `invalid carrier: ${file}`);

  if (declared.length === 0) {
    checks.push(check('hooks.wired', 'pass', 'adapter declares no hooks carrier'));
  } else if (carrierProblems.length > 0) {
    checks.push(check('hooks.wired', 'fail', carrierProblems.slice(0, 2).join('; ')));
  } else {
    const unwired = declared.filter((entry) => {
      const state = carriers.get(join(carrierRoot, ...entry.carrier.split('/')));
      if (state?.module === true) {
        return shim === null || !usesShim(state.text, shim);
      }
      const commands = eventCommands(state?.document, entry.event);
      return shim === null || !commands.some((command) => usesShim(command, shim));
    });
    checks.push(
      unwired.length === 0
        ? check(
            'hooks.wired',
            'pass',
            `${declared.map((entry) => entry.event).join('/')} wired to ${shim}`,
          )
        : check(
            'hooks.wired',
            'fail',
            `settings has no shim command for ${unwired.map((entry) => entry.event).join('/')}`,
          ),
    );
  }

  if (declared.length === 0) {
    checks.push(check('hooks.smoke', 'warn', 'adapter declares no hooks carrier'));
  } else if (shim === null || !shimPresent) {
    checks.push(check('hooks.smoke', 'fail', `payload is missing shims/hook.mjs: ${shim ?? '(no payload)'}`));
  } else if (carrierProblems.length > 0) {
    checks.push(check('hooks.smoke', 'fail', carrierProblems.slice(0, 2).join('; ')));
  } else {
    const modules = [...carriers.values()].filter((state) => state.module === true).length;
    const settings = carriers.size - modules;
    const detail = modules === 0
      ? `shim present; ${settings} settings file(s) parse as JSON`
      : `shim present; ${modules} module carrier(s)${settings === 0 ? '' : `, ${settings} settings file(s) parse as JSON`}`;
    checks.push(check('hooks.smoke', 'pass', detail));
  }

  if (declared.length === 0) {
    checks.push(check('hooks.launch', 'warn', 'adapter declares no hooks carrier'));
  } else if (shim === null || !shimPresent) {
    checks.push(check('hooks.launch', 'fail', 'payload has no shims/hook.mjs to launch'));
  } else if (carrierProblems.length > 0) {
    checks.push(check('hooks.launch', 'fail', carrierProblems.slice(0, 2).join('; ')));
  } else {
    const stopDecl = declared.find((entry) => entry.event === 'Stop');
    const stopState = stopDecl === undefined
      ? null
      : carriers.get(join(carrierRoot, ...stopDecl.carrier.split('/')));
    const stopModule = stopState?.module === true;
    const stopCommands = stopModule
      ? []
      : eventLaunchCommands(stopState?.document, 'Stop', shim);
    if (stopModule && !usesShim(stopState.text, shim)) {
      checks.push(check('hooks.launch', 'fail', 'module carrier does not reference this shim'));
    } else if (!stopModule && stopCommands.length === 0) {
      checks.push(check('hooks.launch', 'fail', 'settings has no configured Stop command for this shim'));
    } else {
      const started = Date.now();
      const isWin = process.platform === 'win32';
      const options = {
        cwd: ctx.projectRoot,
        encoding: 'utf8',
        input: '',
        timeout: 5_000,
        windowsHide: true,
      };
      let result;
      if (stopModule) {
        result = spawnSync(
          process.execPath,
          [shim, '--agent', agentId, '--event', 'stop', '--format', 'json'],
          options,
        );
      } else if (isWin && /\.(?:cmd|bat)$/i.test(stopCommands[0]) && existsSync(stopCommands[0])) {
        // A launcher path may contain spaces; cmd finds it as one /c argument.
        result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', stopCommands[0]], options);
      } else {
        result = spawnSync(stopCommands[0], { ...options, shell: true });
      }
      const elapsed = Date.now() - started;
      if (result.error) {
        checks.push(check('hooks.launch', 'fail', `Stop command could not be launched: ${result.error.message}`));
      } else if (result.status !== 0) {
        checks.push(
          check(
            'hooks.launch',
            'fail',
            `Stop command exited ${result.status} in ${elapsed}ms: ${(result.stderr || '').trim()}`,
          ),
        );
      } else {
        checks.push(check('hooks.launch', 'pass', `Stop command exited 0 in ${elapsed}ms`));
      }
    }
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
