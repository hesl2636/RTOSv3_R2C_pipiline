/**
 * `adapter doctor`: receipt + discovery health, exit 0/3/4.
 *
 * Checks use only local bytes and zero model calls. A missing receipt is exit 4
 * before any check runs; after that every check reports `pass|warn|fail` and
 * one `fail` makes the command exit 3.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { EXIT_CODES, R2cError } from '../errors.js';
import { isValidRange, satisfies } from '../version.js';
import { detectAgent } from './detect.js';
import { runAdapterSmoke } from './smoke.js';
import { receiptPath, stateDir } from './state.js';
import { isFile, isInside, isLink, linkTarget, liveReceipt, readJsonIfExists, receiptEntryPath, sha256File, toPosix, userHome } from './util.js';

function check(name, status, detail) {
  return { name, status, detail };
}

/**
 * The engine this install points at must really run (C6): a deleted, moved or
 * non-executable entry is a `fail` here instead of a silently broken first hook.
 */
function checkEngineEntry(receipt, ctx) {
  const engine = receipt.engine ?? {};
  const entry = typeof engine.entry === 'string' ? engine.entry : '';
  if (entry === '') {
    return check('engine.executable', 'fail', 'receipt records no engine entry; re-run install with --engine <dir>');
  }
  if (!existsSync(entry)) {
    return check('engine.executable', 'fail', `engine entry is missing: ${entry}`);
  }
  const result = spawnSync(process.execPath, [entry, '--version'], {
    cwd: ctx.projectRoot,
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
  });
  if (result.error) {
    return check('engine.executable', 'fail', `engine entry could not run: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || '').trim().slice(0, 200);
    return check(
      'engine.executable',
      'fail',
      `engine entry exited ${result.status}${detail === '' ? '' : `: ${detail}`}`,
    );
  }
  const reported = (result.stdout || '').trim();
  if (reported !== String(engine.version)) {
    return check(
      'engine.executable',
      'fail',
      `engine entry reports "${reported}", receipt records ${engine.version}`,
    );
  }
  return check('engine.executable', 'pass', `${entry} --version → ${reported}`);
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

function verifyFiles(receipt, projectRoot) {
  const problems = [];
  const recordedRoot = receipt.project_root ?? null;
  let verified = 0;
  for (const file of receipt.files ?? []) {
    const path = receiptEntryPath(file, { projectRoot, recordedRoot });
    if (!existsSync(path)) {
      problems.push(`missing:${path}`);
      continue;
    }
    if (file.kind === 'link') {
      if (!isLink(path)) {
        problems.push(`not-a-link:${path}`);
      } else if (!existsSync(linkTarget(path) ?? file.target ?? '')) {
        problems.push(`broken-link:${path}`);
      } else {
        verified += 1;
      }
      continue;
    }
    if (!isFile(path)) {
      problems.push(`not-a-file:${path}`);
      continue;
    }
    if (sha256File(path) !== file.sha256) {
      problems.push(`hash-mismatch:${path}`);
    } else {
      verified += 1;
    }
  }
  return { problems, verified };
}

function shimPath(receipt) {
  return receipt.payload_home ? join(receipt.payload_home, 'shims', 'hook.mjs') : null;
}

/**
 * Paths a carrier may use to reference this shim: the absolute one (user
 * scope, or any carrier outside the project) and, for a project-scope carrier,
 * the project-relative spelling the installer writes so a moved project keeps
 * working.
 */
function shimReferences(receipt, carrierRoot) {
  const absolute = shimPath(receipt);
  if (absolute === null) return [];
  const references = [absolute];
  const rel = relative(carrierRoot, absolute);
  if (rel !== '' && isInside(carrierRoot, absolute)) references.push(toPosix(rel));
  return references;
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

function usesShim(command, shims) {
  const comparable = (value) =>
    (process.platform === 'win32' ? value.toLowerCase() : value).replaceAll('\\', '/');
  const haystack = comparable(command);
  return shims.some((shim) => haystack.includes(comparable(shim)));
}

/**
 * Launch commands for one event, platform-selected and filtered to handlers
 * that reference this shim. `commandWindows` wins on Windows; a handler whose
 * `commandWindows` is a rendered `.cmd` still qualifies through its sibling
 * `command` (the .cmd itself quotes node/shim internally).
 */
function eventLaunchCommands(document, event, shims) {
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
    if (fields.some((field) => usesShim(field, shims))) {
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
  const stored = readJsonIfExists(receiptPath(state, agentId));
  const checks = [];

  if (stored === null) {
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
  // Read every recorded path against the live root: a renamed or moved project
  // keeps its payload, engine and config, it only changed directory.
  const receipt = liveReceipt(stored, ctx.projectRoot);

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

  if (adapter?.capabilities?.stop === 'idle' && agentRange !== null) {
    const pinned = detection.version !== null
      && detection.version !== undefined
      && isValidRange(agentRange)
      && satisfies(detection.version, agentRange);
    checks.push(
      check(
        'platform.pin',
        pinned ? 'pass' : 'warn',
        pinned
          ? `${agentId} ${detection.version} satisfies the V1 pin ${agentRange}`
          : `${agentId} ${detection.version ?? '(unknown)'} is outside the V1 pin ${agentRange}; A′ is unavailable, use B: r2c next --format plain`,
      ),
    );
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
  checks.push(checkEngineEntry(receipt, ctx));

  const files = verifyFiles(receipt, ctx.projectRoot);
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
  // Project scope writes the shim project-relative; user scope writes it absolute.
  const shimRefs = shimReferences(receipt, carrierRoot);
  const carriers = new Map();
  for (const entry of declared) {
    const file = join(carrierRoot, ...entry.carrier.split('/'));
    if (!carriers.has(file)) carriers.set(file, readCarrierFile(file));
  }
  const carrierProblems = [...carriers.entries()]
    .filter(([, state]) => !state.ok)
    .map(([file, state]) => state.detail ?? `invalid carrier: ${file}`);
  const idlePlugin = adapter?.capabilities?.stop === 'idle'
    ? (receipt.files ?? []).find((file) => /[\\/]plugins[\\/]r2c\.ts$/i.test(file.path)) ?? null
    : null;

  if (idlePlugin !== null) {
    checks.push(
      existsSync(idlePlugin.path)
        ? check('hooks.wired', 'pass', `plugin carrier installed: ${idlePlugin.path}`)
        : check('hooks.wired', 'fail', `plugin carrier missing: ${idlePlugin.path}`),
    );
  } else if (adapter?.capabilities?.stop === 'idle') {
    checks.push(
      check(
        'hooks.wired',
        'fail',
        `adapter requires the plugin carrier ${adapter?.hooks?.stop?.carrier ?? '(none)'} but the receipt records no plugin file`,
      ),
    );
  } else if (agentId === 'dsh' && declared.length === 0) {
    checks.push(check('hooks.wired', 'pass', 'native Cordis seams (agent/turn-stopping + tools/pre-execute)'));
  } else if (declared.length === 0) {
    checks.push(check('hooks.wired', 'pass', 'adapter declares no hooks carrier'));
  } else if (carrierProblems.length > 0) {
    checks.push(check('hooks.wired', 'fail', carrierProblems.slice(0, 2).join('; ')));
  } else {
    const unwired = declared.filter((entry) => {
      const state = carriers.get(join(carrierRoot, ...entry.carrier.split('/')));
      if (state?.module === true) {
        return shimRefs.length === 0 || !usesShim(state.text, shimRefs);
      }
      const commands = eventCommands(state?.document, entry.event);
      return shimRefs.length === 0 || !commands.some((command) => usesShim(command, shimRefs));
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

  if (declared.length === 0 && agentId !== 'dsh') {
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

  if (declared.length === 0 && agentId !== 'dsh') {
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
    const nativeSeam = agentId === 'dsh' && stopDecl === undefined;
    const stopCommands = stopModule || nativeSeam
      ? []
      : eventLaunchCommands(stopState?.document, 'Stop', shimRefs);
    if (stopModule && !usesShim(stopState.text, shimRefs)) {
      checks.push(check('hooks.launch', 'fail', 'module carrier does not reference this shim'));
    } else if (!stopModule && !nativeSeam && stopCommands.length === 0) {
      checks.push(check('hooks.launch', 'fail', 'settings has no configured Stop command for this shim'));
    } else {
      const started = Date.now();
      const isWin = process.platform === 'win32';
      // A project-scope launcher is recorded relative to the project root; cmd
      // needs it resolved, and takes a spaced path as one /c argument.
      const launcher = isWin && stopCommands[0] !== undefined && /\.(?:cmd|bat)$/i.test(stopCommands[0])
        ? (isAbsolute(stopCommands[0]) ? stopCommands[0] : resolve(carrierRoot, stopCommands[0]))
        : null;
      const options = {
        cwd: ctx.projectRoot,
        encoding: 'utf8',
        input: '',
        timeout: 5_000,
        windowsHide: true,
      };
      let result;
      if (stopModule || nativeSeam) {
        result = spawnSync(
          process.execPath,
          [shim, '--agent', agentId, '--event', 'stop', '--format', 'json'],
          options,
        );
      } else if (launcher !== null) {
        result = existsSync(launcher)
          ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', launcher], options)
          : { error: new Error(`launcher is missing: ${launcher}`) };
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
    checks.push(checkPluginActivated({ receipt, detection }));
  } else if (adapter?.capabilities?.stop === 'idle') {
    checks.push(
      check(
        'plugin.loaded',
        'warn',
        `plugin load cannot be probed without a live ${agentId} session; installed file: ${idlePlugin?.path ?? '(none)'}. If it is not loaded, use B: r2c next --format plain`,
      ),
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
    check(
      'manual',
      'warn',
      manualSteps.length === 0 ? 'no manual steps declared' : manualSteps.join('; '),
    ),
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
