/**
 * Installer `doctor` (#104, #76 §7.4): read-only integrity checks over
 * receipts, the runtime receipt/launcher/engine, the selected manifest, host
 * detection, degradation/placeholder summaries and transaction residue.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { compareCodePoints } from '../core/code-point.js';
import { foldCase } from '../core/paths.js';
import { BUNDLES_DIR, COMPILED_WORKFLOW_FILENAME } from './paths.js';
import { readJournal } from './transaction.js';
import { readReceipts } from './receipt.js';
import { LAUNCHER_PATH, LAUNCHER_SHA256, readRuntimeReceipt } from './runtime.js';
import { manifestSelection } from './status.js';
import { TARGETS } from '../runtime/agent-native/projection/targets/index.js';
import { sha256File } from './util.js';

export const DOCTOR_SCHEMA = 'hm2b.doctor/v1';

const HOST_ROOTS = Object.freeze({
  'claude-code': '.claude',
  codex: '.codex',
  dsh: '.dsh',
  omp: '.omp',
  opencode: '.opencode',
});

function check(id, level, status, message, details) {
  const value = { id, level, status, message };
  if (details !== undefined) value.details = details;
  return value;
}

function pass(id, message, details) {
  return check(id, 'fail', 'pass', message, details);
}

function fail(id, message, details) {
  return check(id, 'fail', 'fail', message, details);
}

function warn(id, message, details) {
  return check(id, 'warn', 'warn', message, details);
}

function info(id, message, details) {
  return check(id, 'info', 'info', message, details);
}

function absoluteOf(projectRoot, rel) {
  return isAbsolute(rel) ? rel : join(projectRoot, ...rel.split('/'));
}

function walkFiles(root, current = root, out = []) {
  let entries;
  try {
    entries = readdirSync(current, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) walkFiles(root, absolute, out);
    else if (entry.isFile()) out.push(absolute.slice(root.length + 1).split('\\').join('/'));
  }
  return out;
}

function receiptCheck(projectRoot, item) {
  const receipt = item.receipt;
  const missing = [];
  const mismatched = [];
  for (const file of receipt.files ?? []) {
    const absolute = absoluteOf(projectRoot, file.path);
    if (!existsSync(absolute)) {
      missing.push({ path: file.path, reason: 'MISSING' });
      continue;
    }
    const info = statSync(absolute);
    if (!info.isFile()) {
      missing.push({ path: file.path, reason: 'NOT_A_FILE' });
      continue;
    }
    if (sha256File(absolute) !== file.sha256) mismatched.push({ path: file.path, reason: 'HASH_MISMATCH' });
  }
  const id = `receipt:${receipt.projection?.id ?? item.path}`;
  if (missing.length === 0 && mismatched.length === 0) {
    return pass(id, `${receipt.bundle?.id ?? item.path}: ${(receipt.files ?? []).length} file(s) intact`);
  }
  return fail(id, `${receipt.bundle?.id ?? item.path}: ${missing.length} missing, ${mismatched.length} modified`, { missing, mismatched });
}

function rolesJsonCheck(projectRoot, receipts) {
  const runner = receipts.filter((item) => item.receipt.projection?.id === 'runner');
  if (runner.length === 0) return pass('roles.json', 'no runner receipt; nothing to check');
  const path = '.hm2b/projection/roles.json';
  const absolute = absoluteOf(projectRoot, path);
  if (!existsSync(absolute)) return fail('roles.json', `${path} is missing`, { path });
  const recorded = runner.flatMap((item) => item.receipt.files ?? []).find((file) => file.path === path);
  if (recorded === undefined) return fail('roles.json', `${path} is not recorded by the runner receipt`, { path });
  const actual = sha256File(absolute);
  if (actual !== recorded.sha256) return fail('roles.json', `${path} hash does not match the receipt`, { path, expected: recorded.sha256, actual });
  try {
    JSON.parse(readFileSync(absolute, 'utf8'));
  } catch {
    return fail('roles.json', `${path} is not valid JSON`, { path });
  }
  return pass('roles.json', `${path} hash matches the receipt`, { path });
}

function engineChecks(projectRoot, runtime) {
  const checks = [];
  if (runtime === null) {
    return [
      pass('engine.entry', 'no runtime receipt; no engine entry to check'),
      pass('engine.launcher', 'no runtime receipt; no launcher to check'),
      pass('engine.version', 'no runtime receipt; no engine to probe'),
    ];
  }
  const entry = runtime.engine?.entry ?? null;
  const entryAbsolute = typeof entry === 'string' ? absoluteOf(projectRoot, entry) : null;
  if (entryAbsolute !== null && existsSync(entryAbsolute) && statSync(entryAbsolute).isFile()) {
    checks.push(pass('engine.entry', `engine ${runtime.engine.version} entry exists`, { entry }));
  } else {
    checks.push(fail('engine.entry', `runtime.json engine entry is missing: ${String(entry)}`, { entry }));
  }

  const launcherAbsolute = absoluteOf(projectRoot, LAUNCHER_PATH);
  let launcherOk = false;
  if (existsSync(launcherAbsolute) && statSync(launcherAbsolute).isFile()) {
    const actual = sha256File(launcherAbsolute);
    launcherOk = actual === LAUNCHER_SHA256;
    checks.push(launcherOk
      ? pass('engine.launcher', `${LAUNCHER_PATH} bytes match the fixed template`)
      : fail('engine.launcher', `${LAUNCHER_PATH} differs from the fixed template`, {
        expected: LAUNCHER_SHA256,
        actual,
        problems: ['HASH_MISMATCH'],
      }));
  } else {
    checks.push(fail('engine.launcher', `${LAUNCHER_PATH} is missing`, { path: LAUNCHER_PATH, problems: ['MISSING'] }));
  }

  if (!launcherOk || entryAbsolute === null || !existsSync(entryAbsolute)) {
    checks.push(fail('engine.version', 'the launcher cannot be executed because the runtime is incomplete'));
    return checks;
  }
  const run = spawnSync(process.execPath, [launcherAbsolute, '--version'], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, HM2B_SESSION_ID: undefined, HM2B_PROJECT_ROOT: undefined },
  });
  const stdout = String(run.stdout ?? '').trim();
  if (run.status === 0 && stdout === String(runtime.engine.version)) {
    checks.push(pass('engine.version', `launcher reports engine ${stdout}`));
  } else {
    checks.push(fail('engine.version', `launcher reports ${JSON.stringify(stdout)} (status ${run.status}), expected ${runtime.engine.version}`, {
      stdout,
      status: run.status,
      expected: runtime.engine.version,
    }));
  }
  return checks;
}

function manifestCheck(projectRoot, receipts) {
  const manifest = manifestSelection(projectRoot);
  if (manifest.selection === 'single') {
    return pass('manifest.selection', `exactly one workflow: ${manifest.path}`, manifest);
  }
  if (manifest.selection === 'ambiguous') {
    return fail('manifest.selection', `${manifest.candidates.length} workflow manifests; exactly one is required`, manifest);
  }
  const runner = receipts.some((item) => item.receipt.projection?.id === 'runner');
  if (runner) return fail('manifest.selection', 'a runner install must leave exactly one workflows/*.yaml', manifest);
  return pass('manifest.selection', 'no workflow manifest yet', manifest);
}

function extraFilesCheck(projectRoot, receipts, runtime) {
  const owned = new Set();
  for (const item of receipts) {
    for (const file of item.receipt.files ?? []) owned.add(file.path);
    if (typeof item.receipt.compiledWorkflow?.path === 'string') owned.add(item.receipt.compiledWorkflow.path);
    owned.add(item.path);
  }
  if (runtime !== null) {
    owned.add('.hm2b/install/runtime.json');
    owned.add('.hm2b/install/pending.json');
    for (const file of runtime.files ?? []) owned.add(file.path);
    for (const merge of runtime.merged ?? []) owned.add(merge.path);
  }
  const roots = new Set();
  for (const item of receipts) {
    for (const file of item.receipt.files ?? []) {
      const segments = file.path.split('/');
      if (segments[0] === '.hm2b') {
        if (segments[1] === 'projection') roots.add('.hm2b/projection');
        continue;
      }
      roots.add(segments[0]);
    }
  }
  const extra = [];
  for (const root of [...roots].sort(compareCodePoints)) {
    for (const rel of walkFiles(join(projectRoot, ...root.split('/')))) {
      const path = `${root}/${rel}`;
      if (!owned.has(path)) extra.push(path);
    }
  }
  if (extra.length === 0) return pass('extra.files', 'no unowned files under installed roots');
  return warn('extra.files', `${extra.length} file(s) under installed roots are not recorded by any receipt`, {
    extra: extra.sort(compareCodePoints),
  });
}

/**
 * compiled workflow copies are installer-owned but no receipt lists them (#76 §3.3), so a
 * leftover from an interrupted upgrade or a hand copy is invisible to
 * `receipt:` and `extra.files`. One warning line per orphan, keyed by path;
 * an orphan is never a failure, it only suggests a cleanup.
 */
function compiledWorkflowOrphanCheck(projectRoot, receipts) {
  const referenced = new Set();
  for (const item of receipts) {
    const path = item.receipt.compiledWorkflow?.path;
    if (typeof path === 'string' && path !== '') referenced.add(foldCase(path));
  }
  const root = join(projectRoot, ...BUNDLES_DIR.split('/'));
  const orphans = walkFiles(root)
    .filter((rel) => rel.slice(rel.lastIndexOf('/') + 1) === COMPILED_WORKFLOW_FILENAME)
    .map((rel) => `${BUNDLES_DIR}/${rel}`)
    .filter((path) => !referenced.has(foldCase(path)))
    .sort(compareCodePoints);
  if (orphans.length === 0) {
    return [pass('compiledWorkflow.orphan', `every ${COMPILED_WORKFLOW_FILENAME} copy under ${BUNDLES_DIR} is referenced by a receipt`)];
  }
  return orphans.map((path) => warn('compiledWorkflow.orphan', path, {
    path,
    fix: `delete ${path}, or reinstall the bundle that owns it`,
  }));
}

/**
 * Target smoke: every selected host's installed file groups still satisfy the
 * descriptor's structural expectation (skills have frontmatter, agents carry a
 * name/description, the roles.json metadata parses). This is the replacement
 * for the retired `acceptance` agent face: model-free, project-local.
 */
function targetSmokeCheck(projectRoot, receipts) {
  const results = [];
  for (const item of receipts) {
    const receipt = item.receipt;
    if (receipt.projection?.id !== 'agent-native') continue;
    const namespace = receipt.bundle?.id;
    if (typeof namespace !== 'string' || namespace === '') continue;
    const targets = new Set(receipt.host_targets ?? []);
    for (const file of receipt.files ?? []) {
      for (const target of file.targets ?? []) targets.add(target);
    }
    for (const target of [...targets].sort(compareCodePoints)) {
      const descriptor = TARGETS[target];
      if (descriptor?.smoke === undefined) continue;
      const missing = [];
      for (const expectation of descriptor.smoke(namespace)) {
        if (expectation.kind === 'metadata') {
          const absolute = join(projectRoot, ...`${expectation.root}/${expectation.prefix}`.split('/'));
          if (!existsSync(absolute)) missing.push(`metadata:${expectation.root}/${expectation.prefix}`);
          else {
            try {
              JSON.parse(readFileSync(absolute, 'utf8'));
            } catch {
              missing.push(`metadata-json:${expectation.root}/${expectation.prefix}`);
            }
          }
          continue;
        }
        const dir = join(projectRoot, ...expectation.root.split('/'));
        let names = [];
        try {
          names = readdirSync(dir).filter((name) => name.startsWith(expectation.prefix));
        } catch {
          names = [];
        }
        if (names.length === 0) {
          missing.push(`${expectation.kind}:${expectation.root}/${expectation.prefix}*`);
          continue;
        }
        for (const name of names) {
          const absolute = join(dir, name);
          let text;
          try {
            if (!statSync(absolute).isFile()) continue;
            text = readFileSync(absolute, 'utf8');
          } catch {
            missing.push(`unreadable:${expectation.root}/${name}`);
            continue;
          }
          if (text.trim() === '') {
            missing.push(`empty:${expectation.root}/${name}`);
            continue;
          }
          if (expectation.format === 'toml') {
            if (!/^\s*name\s*=\s*"/m.test(text) || !/^\s*description\s*=\s*"/m.test(text)) {
              missing.push(`toml-metadata:${expectation.root}/${name}`);
            }
          } else if (expectation.format === 'skill' || expectation.format === 'md') {
            const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
            if (frontmatter === null || !/^name\s*:/m.test(frontmatter[1]) || !/^description\s*:/m.test(frontmatter[1])) {
              missing.push(`md-metadata:${expectation.root}/${name}`);
            }
          }
        }
      }
      results.push(
        missing.length === 0
          ? pass(`target.smoke:${target}`, `${target} discovery files are present and readable`, { namespace })
          : fail(`target.smoke:${target}`, `${target} discovery files are missing or invalid`, { namespace, missing }),
      );
    }
  }
  return results;
}

function hostDetectionCheck(projectRoot, receipts, runtime) {
  const targets = new Set([...(runtime?.host_targets ?? []), ...receipts.flatMap((item) => item.receipt.host_targets ?? [])]);
  const entries = [...targets].sort(compareCodePoints).map((target) => {
    const root = HOST_ROOTS[target] ?? null;
    return {
      target,
      detected: root === null ? false : existsSync(join(projectRoot, ...root.split('/'))),
      root,
    };
  });
  return info('host.detection', `${entries.filter((entry) => entry.detected).length}/${entries.length} selected host(s) detected in the project`, { targets: entries });
}

function transactionCheck(projectRoot) {
  const journal = readJournal(projectRoot);
  if (journal === null) {
    return existsSync(join(projectRoot, '.hm2b/install/.lock'))
      ? warn('transaction.residue', 'a lock file is present', { lock: '.hm2b/install/.lock' })
      : pass('transaction.residue', 'no pending journal or lock residue');
  }
  if (journal.state === 'rollback-failed') {
    return fail('transaction.residue', 'a failed rollback journal is kept; restore the listed paths', {
      state: journal.state,
      operations: journal.operations,
    });
  }
  return warn('transaction.residue', `a ${journal.state ?? 'pending'} transaction journal is present`, {
    state: journal.state ?? null,
    started_at: journal.started_at ?? null,
  });
}

function summaryCheck(receipts) {
  let degradations = 0;
  let placeholderRoles = 0;
  let placeholderSkills = 0;
  let placeholders = 0;
  const byTarget = {};
  for (const item of receipts) {
    degradations += (item.receipt.degradations ?? []).length;
    for (const record of item.receipt.degradations ?? []) {
      byTarget[record.target ?? 'runner'] = (byTarget[record.target ?? 'runner'] ?? 0) + 1;
    }
    placeholderRoles += (item.receipt.metadata?.placeholders?.roles ?? []).length;
    placeholderSkills += (item.receipt.metadata?.placeholders?.skills ?? []).length;
    if (item.receipt.metadata?.placeholders?.constitution === true || item.receipt.metadata?.placeholders?.constitution === 'placeholder') placeholders += 1;
  }
  placeholders += placeholderRoles + placeholderSkills;
  return info('summary', `${degradations} degradation(s), ${placeholders} placeholder(s) (${placeholderRoles} role, ${placeholderSkills} skill)`, {
    degradations,
    degradationsByTarget: byTarget,
    placeholders,
    placeholderRoles,
    placeholderSkills,
  });
}

function legacyCheck(legacy) {
  if (legacy.length === 0) return pass('legacy.receipts', 'no legacy r2c.install/v1 receipt');
  return warn('legacy.receipts', `${legacy.length} legacy receipt(s) still present; migration is pending`, { paths: legacy.map((item) => item.path) });
}

/** Read-only doctor report; `ok` is false when any check fails. */
export function doctor(projectRootInput) {
  const projectRoot = resolve(projectRootInput);
  const { receipts, invalid, legacy } = readReceipts(projectRoot);
  const checks = [];

  if (invalid.length === 0) checks.push(pass('receipts', `${receipts.length} receipt(s) parsed`));
  else checks.push(fail('receipts', `${invalid.length} receipt(s) could not be read`, { invalid }));
  checks.push(legacyCheck(legacy));

  const seen = new Set();
  for (const item of receipts) {
    const id = `receipt:${item.receipt.projection?.id ?? item.path}`;
    if (seen.has(id)) continue;
    seen.add(id);
    checks.push(receiptCheck(projectRoot, item));
  }

  let runtime = null;
  try {
    runtime = readRuntimeReceipt(projectRoot);
  } catch (error) {
    checks.push(fail('engine.receipt', error?.message ?? 'runtime.json is invalid'));
  }
  if (runtime !== null) checks.push(pass('engine.receipt', `runtime ${runtime.engine.version} recorded`));
  checks.push(rolesJsonCheck(projectRoot, receipts));
  checks.push(...engineChecks(projectRoot, runtime));
  checks.push(manifestCheck(projectRoot, receipts));
  checks.push(extraFilesCheck(projectRoot, receipts, runtime));
  checks.push(...compiledWorkflowOrphanCheck(projectRoot, receipts));
  checks.push(hostDetectionCheck(projectRoot, receipts, runtime));
  checks.push(...targetSmokeCheck(projectRoot, receipts));
  checks.push(transactionCheck(projectRoot));
  checks.push(summaryCheck(receipts));

  const ok = checks.every((item) => item.status !== 'fail');
  return {
    schema: DOCTOR_SCHEMA,
    root: projectRoot,
    ok,
    checks,
    summary: {
      pass: checks.filter((item) => item.status === 'pass').length,
      fail: checks.filter((item) => item.status === 'fail').length,
      warn: checks.filter((item) => item.status === 'warn').length,
      info: checks.filter((item) => item.status === 'info').length,
    },
  };
}

export function formatDoctor(report) {
  return `${report.checks.map((item) => `${item.status}/${item.id}: ${item.message}`).join('\n')}\n`;
}
