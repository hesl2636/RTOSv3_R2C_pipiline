/**
 * The single installer.
 *
 * Order of operations is fixed by #7 §4: detect → resolve/verify payload →
 * version gate → plan → conflict scan → pending marker → backups → atomic
 * writes → post-install smoke → receipt. Every step before `pending` is
 * read-only, so a bad payload, a version mismatch, a conflict without
 * `--force` or `--dry-run` leaves the project untouched.
 */
import { cpSync, existsSync, readFileSync, rmdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { EXIT_CODES, R2cError } from '../errors.js';
import { isValidRange, satisfies } from '../version.js';
import { withLock } from '../lock.js';
import { detectAgent } from './detect.js';
import { buildPlan, defaultRunnerCommand, loadAdapterDeclaration } from './plan.js';
import { materializePayload, payloadHome, payloadReady, resolvePayload } from './payload.js';
import { pointerGet, pointerSet } from './pointer.js';
import { runAdapterSmoke } from './smoke.js';
import { runAdapterStep, stepsFile, undoAdapterStep } from './steps.js';
import {
  backupDir,
  installLockPath,
  pendingPath,
  receiptPath,
  stateDir,
  timestampSlug,
} from './state.js';
import {
  atomicWriteFile,
  atomicWriteJson,
  createDirLink,
  ensureDir,
  isFile,
  isInside,
  isLink,
  linkTarget,
  readJsonIfExists,
  receiptFilePath,
  removePath,
  sha256File,
  userHome,
} from './util.js';

function installError(code, message, details = null, exitCode = EXIT_CODES.USAGE) {
  return new R2cError(code, message, details, exitCode);
}

function pathKey(path) {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

function effectiveMode(options, adapter) {
  const copy = options.copy === true;
  const link = options.link === true;
  if (copy && link) {
    throw installError('MODE_CONFLICT', '--copy and --link are mutually exclusive');
  }
  if (link) {
    if (!options.from) {
      throw installError('LINK_REQUIRES_FROM', '--link is only supported together with --from <dir>', {
        option: '--link',
      });
    }
    const fromPath = resolve(process.cwd(), options.from);
    if (existsSync(fromPath) && statSync(fromPath).isFile()) {
      throw installError(
        'LINK_REQUIRES_DIR',
        '--link is only supported with an unpacked --from <dir>; a .tgz payload installs with --copy',
        { option: '--link', from: options.from },
      );
    }
    if (Array.isArray(adapter.modes) && !adapter.modes.includes('link')) {
      throw installError(
        'MODE_UNSUPPORTED',
        `adapter ${adapter.id} does not support --link; use the default --copy`,
        { adapter: adapter.id, mode: 'link', supported: adapter.modes },
      );
    }
    return 'link';
  }
  if (copy) return 'copy';
  return adapter.defaults?.mode === 'link' ? 'link' : 'copy';
}

function resolveScope(options, adapter) {
  const scopes = adapter.scopes ?? ['project'];
  const scope = options.scope ?? adapter.defaults?.scope ?? scopes[0];
  if (!scopes.includes(scope)) {
    throw installError('SCOPE_UNSUPPORTED', `adapter ${adapter.id} does not support scope "${scope}"`, {
      adapter: adapter.id,
      scope,
      supported: scopes,
    });
  }
  return scope;
}

function gateVersions({ ctx, resolved, adapter, mode }) {
  const warnings = [];
  const ranges = [
    { label: 'payload.engine', range: resolved.manifest.engine },
    { label: 'adapter.requires.engine', range: adapter.requires?.engine },
  ];
  for (const { label, range } of ranges) {
    if (range === undefined) continue;
    if (!isValidRange(range)) {
      throw installError('ENGINE_RANGE_INVALID', `invalid engine range in ${label}: ${range}`, {
        label,
        range,
      });
    }
    if (satisfies(ctx.version, range)) continue;
    if (mode === 'link') {
      warnings.push(`engine-range:${label} requires ${range}, engine ${ctx.version} (warn: --link)`);
      continue;
    }
    throw installError(
      'ENGINE_RANGE',
      `${label} requires ${range}, engine is ${ctx.version}; --force does not bypass the version gate`,
      { actual: ctx.version, required: range, label },
    );
  }
  return warnings;
}

function gateAgent({ detection, adapter }) {
  const warnings = [];
  const range = adapter.requires?.agent;
  if (range !== undefined && detection.version !== null && detection.version !== undefined) {
    if (!isValidRange(range)) {
      throw installError('AGENT_RANGE_INVALID', `invalid agent range: ${range}`, { range });
    }
    if (!satisfies(detection.version, range)) {
      warnings.push(
        `agent.below-min: requires ${range}, detected ${detection.version} (warning only)`,
      );
    }
  }
  return warnings;
}

function backupTarget(state, agentId, timestamp, target, scope, projectRoot) {
  const root = scope === 'user' ? userHome() : projectRoot;
  let rel = relative(root, target);
  if (rel === '' || rel.startsWith('..') || !isInside(root, target)) {
    rel = target.replace(/[^a-zA-Z0-9._-]+/g, '_');
  }
  const destination = join(
    backupDir(state, agentId, timestamp),
    ...rel.split(sep).filter((part) => part !== ''),
  );
  ensureDir(dirname(destination));
  cpSync(target, destination, { recursive: true, force: true, dereference: false });
  return destination;
}

function recordBackup(pending, entry) {
  pending.backups.push(entry);
}

function pushDirs(created, dirs) {
  for (const dir of dirs) if (!created.includes(dir)) created.push(dir);
}

function groupMerges(entries) {
  const groups = new Map();
  for (const entry of entries) {
    if (!groups.has(entry.target)) groups.set(entry.target, []);
    groups.get(entry.target).push(entry);
  }
  return groups;
}

function scanMergeGroup(group) {
  const target = group[0].target;
  const exists = existsSync(target);
  let document = {};
  if (exists) {
    try {
      document = JSON.parse(readFileSync(target, 'utf8'));
    } catch (error) {
      throw installError(
        'TARGET_INVALID_JSON',
        `cannot merge into ${target}: ${error.message}`,
        { path: target },
      );
    }
  }
  const pending = [];
  for (const entry of group) {
    const container = pointerGet(document, entry.pointer);
    for (const [key, value] of Object.entries(entry.values)) {
      const current = container !== undefined && container !== null && typeof container === 'object' ? container[key] : undefined;
      if (Array.isArray(value)) {
        const currentItems = Array.isArray(current) ? current : [];
        const added = value.filter((item) => !currentItems.some((existing) => isDeepStrictEqual(existing, item)));
        if (added.length > 0) pending.push({ entry, key, value: [...currentItems, ...added], added });
        continue;
      }
      if (!isDeepStrictEqual(current, value)) pending.push({ entry, key, value });
    }
  }
  return { target, exists, document, needsWrite: !exists || pending.length > 0, pending };
}

/**
 * Context passed to every adapter step. It is deliberately JSON-serialisable:
 * the pending marker stores it verbatim so crash recovery can call rollback.
 */
function stepContext({ ctx, adapter, scope, mode, home, runnerCmd, resolved, options, prior }) {
  return {
    adapter: adapter.id,
    scope,
    mode,
    projectRoot: ctx.projectRoot,
    payloadHome: home,
    runnerCmd,
    version: resolved.manifest.version,
    profile: options.profile ?? adapter.options?.profile?.default ?? null,
    mcp: options.mcp === undefined || options.mcp === null ? null : resolve(process.cwd(), options.mcp),
    state: null,
    receipt: prior ?? null,
    undo: { files: [], created_files: [], mcp_ids: [] },
  };
}

function rollback(pending) {
  for (const file of [...(pending.created_files ?? [])].reverse()) {
    try {
      unlinkSync(file);
    } catch {
      try {
        removePath(file);
      } catch {
        // best effort
      }
    }
  }
  for (const backup of [...(pending.backups ?? [])].reverse()) {
    if (backup.linkTarget !== undefined) {
      try {
        removePath(backup.path);
        createDirLink(backup.path, backup.linkTarget);
      } catch {
        // best effort
      }
      continue;
    }
    try {
      ensureDir(dirname(backup.path));
      cpSync(backup.backup, backup.path, { recursive: true, force: true, dereference: false });
    } catch {
      // best effort
    }
  }
  if (pending.payload_created) {
    try {
      removePath(pending.payload_home);
    } catch {
      // best effort
    }
  }
  for (const dir of [...(pending.created_dirs ?? [])].reverse()) {
    try {
      rmdirSync(dir);
    } catch {
      // not empty or already gone
    }
  }
}

/** Crash recovery: a pending marker means the previous install never finished. */
async function recoverPending(state, agentId, warnings) {
  const file = pendingPath(state, agentId);
  if (!existsSync(file)) return;
  const pending = readJsonIfExists(file);
  if (pending !== null) {
    await undoAdapterStep(pending.steps, warnings);
    rollback(pending);
    warnings.push('recovered incomplete install from pending marker');
  }
  try {
    unlinkSync(file);
  } catch {
    // ignore
  }
}

function collectFilePlan(planEntries, prior, options, projectRoot) {
  const priorByPath = new Map(
    (prior?.files ?? []).map((file) => [pathKey(receiptFilePath(file, projectRoot)), file]),
  );
  const conflicts = [];
  const decisions = [];
  for (const entry of planEntries) {
    const key = pathKey(entry.target);
    const known = priorByPath.get(key) ?? null;
    const exists = existsSync(entry.target);
    if (entry.action === 'merge-json') continue;
    if (!exists) {
      decisions.push({ entry, write: true, backup: false, known });
      continue;
    }
    if (entry.action === 'link') {
      if (known !== null && known.kind === 'link' && known.target === entry.linkTarget) {
        decisions.push({ entry, write: false, known });
      } else if (known !== null) {
        decisions.push({ entry, write: true, backup: true, known });
      } else if (options.force) {
        decisions.push({ entry, write: true, backup: true, known });
      } else {
        conflicts.push({ path: entry.target, kind: 'link' });
      }
      continue;
    }
    if (!isFile(entry.target)) {
      if (known !== null) decisions.push({ entry, write: true, backup: true, known });
      else if (options.force) decisions.push({ entry, write: true, backup: true, known });
      else conflicts.push({ path: entry.target, kind: 'directory' });
      continue;
    }
    const actual = sha256File(entry.target);
    if (known !== null && known.kind !== 'link' && known.sha256 === entry.sha256 && actual === entry.sha256) {
      decisions.push({ entry, write: false, known });
    } else if (known !== null) {
      decisions.push({ entry, write: true, backup: true, known });
    } else if (options.force) {
      decisions.push({ entry, write: true, backup: true, known });
    } else {
      conflicts.push({ path: entry.target, kind: 'file' });
    }
  }
  return { conflicts, decisions };
}

function buildReceipt({ ctx, resolved, adapter, scope, mode, runnerCmd, detection, decisions, merged, mergedFilesCreated, prior, state, home }) {
  const now = ctx.now().toISOString();
  const files = [];
  for (const decision of decisions) {
    const { entry, write, known } = decision;
    if (!write && known !== null) {
      files.push(known);
      continue;
    }
    if (!write) continue;
    files.push(
      entry.action === 'link'
        ? { path: entry.target, kind: 'link', sha256: null, target: entry.linkTarget }
        : entry.action === 'layout'
          ? { path: entry.rel, kind: 'layout', sha256: entry.sha256 }
          : { path: entry.target, kind: entry.kind ?? entry.action, sha256: entry.sha256, source: entry.sourceRel },
    );
  }
  const hasLayout = files.some((file) => file.kind === 'layout');
  return {
    schema: 'r2c.install/v1',
    adapter: adapter.id,
    scope,
    // Layout copies live in the project root even for user scope, so the
    // receipt must say which project it wrote into for uninstall to revert them.
    project_root: hasLayout || scope !== 'user' ? ctx.projectRoot : null,
    payload_home: home,
    mode,
    payload: {
      version: resolved.manifest.version,
      sha256: resolved.sha256,
      source: resolved.source,
    },
    engine: { version: ctx.version, requires: adapter.requires?.engine ?? null },
    runner_cmd: runnerCmd,
    requires: {
      engine: adapter.requires?.engine ?? null,
      agent: adapter.requires?.agent ?? null,
    },
    agent: { bin: detection.bin, version: detection.version },
    files,
    merged,
    merged_files_created: mergedFilesCreated,
    backups: [],
    manual: adapter.manualSteps ?? [],
    dirs_created: prior?.dirs_created ? [...prior.dirs_created] : [],
    installed_at: prior?.installed_at ?? now,
    updated_at: now,
    state_dir: state,
  };
}

export async function installAdapter({ ctx, agentId, options }) {
  const resolved = await resolvePayload({
    from: options.from ?? null,
    pluginVersion: options.plugin ?? null,
    projectRoot: ctx.projectRoot,
    engineVersion: ctx.version,
  });
  try {
    const { adapter, map } = loadAdapterDeclaration(resolved, agentId);
    const scope = resolveScope(options, adapter);
    const state = stateDir(scope, ctx.projectRoot);
    if (options.dryRun) {
      return await installOnce({ ctx, agentId, options, state, resolved, adapter, map, scope });
    }
    return await withLock(installLockPath(state), () =>
      installOnce({ ctx, agentId, options, state, resolved, adapter, map, scope }),
    );
  } finally {
    if (typeof resolved.cleanup === 'function') resolved.cleanup();
  }
}

async function installOnce({ ctx, agentId, options, state, resolved, adapter, map, scope }) {
  const warnings = [];
  {
    const mode = effectiveMode(options, adapter);
    const detection = detectAgent(adapter.detect);
    if (!detection.detected && !options.agentExplicit) {
      throw installError(
        'AGENT_NOT_DETECTED',
        `agent ${adapter.id} was not detected`,
        { adapter: adapter.id, probes: detection.probes, paths: detection.paths },
        EXIT_CODES.NO_ACTIVE_RUN,
      );
    }
    if (options.agentExplicit && !detection.detected) {
      warnings.push('agent-detection-skipped:--agent was given explicitly');
    }
    warnings.push(...gateVersions({ ctx, resolved, adapter, mode }));
    warnings.push(...gateAgent({ detection, adapter }));

    const home = payloadHome(scope, ctx.projectRoot, resolved.manifest.version);
    const runnerCmd = defaultRunnerCommand(ctx, resolved);
    const plan = buildPlan({
      resolved,
      adapter,
      map,
      scope,
      mode,
      projectRoot: ctx.projectRoot,
      payloadHome: home,
      runnerCmd,
      mcpPath: options.mcp ?? null,
    });
    warnings.push(...plan.warnings);

    const prior = readJsonIfExists(receiptPath(state, adapter.id));
    if (!options.dryRun) await recoverPending(state, adapter.id, warnings);
    const payloadNeeded = !payloadReady(home, resolved);
    const filePlan = plan.entries.filter((entry) => entry.action !== 'merge-json');
    const { conflicts, decisions } = collectFilePlan(filePlan, prior, options, ctx.projectRoot);
    const mergeGroups = groupMerges(plan.entries.filter((entry) => entry.action === 'merge-json'));
    const mergeScans = new Map();
    for (const [target, group] of mergeGroups) mergeScans.set(target, scanMergeGroup(group));

    if (conflicts.length > 0 && !options.force) {
      throw installError(
        'CONFLICT',
        'refusing to overwrite files that are not part of this install; re-run with --force to back them up and replace',
        {
          conflicts,
          hint: 'pass --force to back up and overwrite, or remove the files yourself',
        },
      );
    }

    const writes = decisions.filter((decision) => decision.write);
    const mergeWrites = [...mergeScans.values()].filter((scan) => scan.needsWrite);
    const changed = payloadNeeded || writes.length > 0 || mergeWrites.length > 0;
    const externalStepFile = stepsFile(resolved, adapter.id, home);
    const runSteps = externalStepFile !== null && (changed || prior?.steps === null || prior?.steps === undefined);

    const manual = [...(adapter.manualSteps ?? [])];
    if (options.dryRun) {
      return {
        command: 'adapter.install',
        data: {
          adapter: adapter.id,
          scope,
          action: changed ? (prior === null ? 'install' : 'upgrade') : 'noop',
          changed,
          dry_run: true,
          payload_home: home,
          payload: {
            version: resolved.manifest.version,
            sha256: resolved.sha256,
            source: resolved.source,
          },
          engine: { version: ctx.version, requires: adapter.requires?.engine ?? null },
          runner_cmd: runnerCmd,
          requires: { engine: adapter.requires?.engine ?? null, agent: adapter.requires?.agent ?? null },
          agent: { bin: detection.bin, version: detection.version },
          plan: [
            ...(payloadNeeded ? [{ action: 'payload', target: home }] : []),
            ...writes.map(({ entry }) => ({ action: entry.action, target: entry.target })),
            ...mergeWrites.map((scan) => ({ action: 'merge-json', target: scan.target })),
            ...(runSteps ? [{ action: 'steps', target: externalStepFile }] : []),
          ],
          files: [],
          skipped: decisions.filter((decision) => !decision.write).map(({ entry }) => entry.target),
          warnings,
          manual,
          leftover: [],
        },
      };
    }

    if (!changed && !runSteps) {
      return {
        command: 'adapter.install',
        data: {
          adapter: adapter.id,
          scope,
          action: 'noop',
          changed: false,
          payload_home: home,
          payload: {
            version: resolved.manifest.version,
            sha256: resolved.sha256,
            source: resolved.source,
          },
          engine: { version: ctx.version, requires: adapter.requires?.engine ?? null },
          runner_cmd: runnerCmd,
          requires: { engine: adapter.requires?.engine ?? null, agent: adapter.requires?.agent ?? null },
          agent: { bin: detection.bin, version: detection.version },
          files: [],
          skipped: decisions.filter((decision) => !decision.write).map(({ entry }) => entry.target),
          warnings,
          manual,
          leftover: [],
        },
      };
    }

    const timestamp = timestampSlug(ctx.now());
    const pending = {
      adapter: adapter.id,
      started_at: ctx.now().toISOString(),
      payload_home: home,
      payload_created: false,
      created_files: [],
      created_dirs: [],
      backups: [],
    };
    ensureDir(dirname(pendingPath(state, adapter.id)));
    atomicWriteJson(pendingPath(state, adapter.id), pending);

    try {
      if (payloadNeeded) {
        const materialized = materializePayload(resolved, home, { mode });
        pending.payload_created = materialized.created;
        pushDirs(pending.created_dirs, materialized.dirs);
        atomicWriteJson(pendingPath(state, adapter.id), pending);
      }

      const merged = new Map();
      const mergedFilesCreated = new Set(prior?.merged_files_created ?? []);
      for (const scan of mergeWrites) {
        const existed = scan.exists;
        if (existed) {
          recordBackup(pending, {
            path: scan.target,
            backup: backupTarget(state, adapter.id, timestamp, scan.target, scope, ctx.projectRoot),
          });
        } else {
          pending.created_files.push(scan.target);
          pushDirs(pending.created_dirs, ensureDir(dirname(scan.target)));
          mergedFilesCreated.add(scan.target);
        }
        const document = existed ? scan.document : {};
        for (const { entry, key, value, added } of scan.pending) {
          const current = pointerGet(document, entry.pointer);
          const base = current !== null && typeof current === 'object' && !Array.isArray(current) ? current : {};
          pointerSet(document, entry.pointer, { ...base, [key]: value });
          const pointer = entry.pointer === null ? key : `${entry.pointer}.${key}`;
          merged.set(`${scan.target}|${pointer}`, { file: scan.target, pointer, value, ...(added ? { added } : {}) });
        }
        atomicWriteFile(scan.target, `${JSON.stringify(document, null, 2)}\n`);
      }
      for (const entry of prior?.merged ?? []) {
        const key = `${entry.file}|${entry.pointer}`;
        if (!merged.has(key)) merged.set(key, entry);
      }
      atomicWriteJson(pendingPath(state, adapter.id), pending);

      for (const decision of writes) {
        const { entry } = decision;
        if (decision.backup) {
          if (entry.action === 'link' && isLink(entry.target)) {
            recordBackup(pending, { path: entry.target, linkTarget: linkTarget(entry.target) });
            removePath(entry.target);
          } else {
            recordBackup(pending, {
              path: entry.target,
              backup: backupTarget(state, adapter.id, timestamp, entry.target, scope, ctx.projectRoot),
            });
          }
        }
        pushDirs(pending.created_dirs, ensureDir(dirname(entry.target)));
        const preexisting = existsSync(entry.target);
        if (preexisting && entry.action !== 'link' && !isFile(entry.target) && !isLink(entry.target)) {
          removePath(entry.target);
        }
        if (entry.action === 'link') {
          if (preexisting) removePath(entry.target);
          try {
            createDirLink(entry.target, entry.linkTarget);
          } catch (error) {
            throw installError(
              'LINK_UNSUPPORTED',
              `cannot create directory link ${entry.target} -> ${entry.linkTarget}: ${error.message}; rerun with --copy`,
              { path: entry.target, target: entry.linkTarget },
            );
          }
        } else {
          atomicWriteFile(entry.target, entry.content);
        }
        if (!preexisting) pending.created_files.push(entry.target);
      }
      atomicWriteJson(pendingPath(state, adapter.id), pending);

      let stepsOutcome = null;
      if (runSteps) {
        const context = stepContext({
          ctx,
          adapter,
          scope,
          mode,
          home,
          runnerCmd,
          resolved,
          options,
          prior,
        });
        context.state = state;
        pending.steps = {
          file: externalStepFile,
          context,
          undo: context.undo,
        };
        atomicWriteJson(pendingPath(state, adapter.id), pending);
        stepsOutcome = await runAdapterStep(externalStepFile, 'post-install', context)
          ?? { warnings: [], leftover: [], receipt: null, undo: null };
        warnings.push(...stepsOutcome.warnings);
        pending.steps.undo = stepsOutcome.undo ?? context.undo;
        atomicWriteJson(pendingPath(state, adapter.id), pending);
      }

      if (!options.noSmoke) {
        const smoke = runAdapterSmoke({
          payloadHome: home,
          agentId: adapter.id,
          scope,
          projectRoot: ctx.projectRoot,
        });
        if (!smoke.ok) {
          throw installError(
            'SMOKE_FAILED',
            `post-install smoke failed: ${smoke.detail ?? 'unknown error'}`,
            { adapter: adapter.id, status: smoke.status, detail: smoke.detail },
            EXIT_CODES.GATE,
          );
        }
        if (!smoke.available) warnings.push('smoke-unavailable:no smoke.mjs in payload');
      }

      const receipt = buildReceipt({
        ctx,
        resolved,
        adapter,
        scope,
        mode,
        runnerCmd,
        detection,
        decisions,
        merged: [...merged.values()],
        mergedFilesCreated: [...mergedFilesCreated],
        prior,
        state,
        home,
      });
      receipt.dirs_created = [...new Set([...(prior?.dirs_created ?? []), ...pending.created_dirs])];
      receipt.backups = pending.backups.map((backup) => ({
        path: backup.path,
        backup: backup.backup ?? null,
        link_target: backup.linkTarget ?? null,
        at: timestamp,
      }));
      if (runSteps) {
        receipt.steps = stepsOutcome.receipt ?? {};
        receipt.steps_file = externalStepFile;
      } else {
        receipt.steps = prior?.steps ?? null;
        receipt.steps_file = prior?.steps_file ?? null;
      }
      receipt.step_leftover = stepsOutcome?.leftover ?? prior?.step_leftover ?? [];
      atomicWriteJson(receiptPath(state, adapter.id), receipt);
      unlinkSync(pendingPath(state, adapter.id));

      return {
        command: 'adapter.install',
        data: {
          adapter: adapter.id,
          scope,
          action: prior === null ? 'installed' : 'upgraded',
          changed: true,
          payload_home: home,
          payload: receipt.payload,
          engine: receipt.engine,
          runner_cmd: runnerCmd,
          requires: receipt.requires,
          agent: receipt.agent,
          files: receipt.files.filter((file) => writes.some(
            ({ entry }) => pathKey(entry.target) === pathKey(receiptFilePath(file, ctx.projectRoot)),
          )),
          skipped: decisions.filter((decision) => !decision.write).map(({ entry }) => entry.target),
          warnings,
          manual,
          leftover: [...receipt.step_leftover],
        },
      };
    } catch (error) {
      await undoAdapterStep(pending.steps, warnings);
      rollback(pending);
      try {
        unlinkSync(pendingPath(state, adapter.id));
      } catch {
        // ignore
      }
      throw error;
    }
  }
}
