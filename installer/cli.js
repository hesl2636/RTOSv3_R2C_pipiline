#!/usr/bin/env node
/**
 * Installer CLI (#94, #104).
 *
 * It consumes an already projected, already validated result — it never
 * compiles a bundle and never re-projects:
 *
 *   node installer/cli.js --result <dir|result.json> --project <dir> [--ir <file>]
 *                         [--runtime <engineSource>] [--engine-version <V>]
 *                         [--engine-home <dir>] [--dry-run] [--force] [--json]
 *   node installer/cli.js --uninstall --bundle <id> --projection <id>
 *                         --project <dir> [--force] [--dry-run] [--json]
 *   node installer/cli.js --status|--doctor --project <dir> [--json]
 *
 * A result directory is `projection-result.json` + `files/<path>` and the
 * `workflow.ir.json` it was projected from. `V1–V12` bind the result to that
 * IR, so the IR is required; `--ir` wins over the directory copy.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toEnvelope } from '../core/diagnostics.js';
import { compareCodePoints } from '../core/code-point.js';
import { EXIT_CODES } from '../core/exit-codes.js';
import { doctor, formatDoctor } from './doctor.js';
import { installR2cProject } from './r2c.js';
import { installRuntime } from './runtime.js';
import { formatStatus, installStatus } from './status.js';
import { uninstallProjection } from './uninstall.js';

const USAGE = [
  'usage: installer/cli.js --result <dir|result.json> --project <dir> [--ir <file>] [--dry-run] [--force] [--json]',
  '       installer/cli.js --runtime <engineSource> [--engine-version <V>] [--engine-home <dir>] --project <dir> [--dry-run] [--force] [--json]',
  '       installer/cli.js --uninstall --bundle <id> --projection <id> --project <dir> [--force] [--dry-run] [--json]',
  '       installer/cli.js --status|--doctor --project <dir> [--json]',
].join('\n');

const VALUES = new Set(['result', 'project', 'ir', 'bundle', 'projection', 'runtime', 'engine-version', 'engine-home']);
const FLAGS = new Set(['dry-run', 'force', 'uninstall', 'json', 'migrate-legacy', 'help', 'status', 'doctor']);

function usageError(message) {
  return { code: 'USAGE', message, details: null };
}

function parseArgs(argv) {
  const options = { values: {}, flags: new Set(), positionals: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h') {
      options.flags.add('help');
      continue;
    }
    if (!arg.startsWith('--')) {
      options.positionals.push(arg);
      continue;
    }
    const [rawName, inline] = arg.slice(2).split('=', 2);
    if (FLAGS.has(rawName)) {
      if (inline !== undefined) return { error: usageError(`--${rawName} does not take a value`) };
      options.flags.add(rawName);
      continue;
    }
    if (!VALUES.has(rawName)) return { error: usageError(`unknown option: ${arg}`) };
    if (inline !== undefined) {
      options.values[rawName] = inline;
      continue;
    }
    if (argv[index + 1] === undefined) return { error: usageError(`--${rawName} requires a value`) };
    options.values[rawName] = argv[index + 1];
    index += 1;
  }
  return { options };
}

function listPayload(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) out.push(absolute);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

function payloadProblems(result, payloadDir) {
  const problems = [];
  const declared = new Set((result.files ?? []).map((file) => file.path));
  const actual = new Set();
  for (const absolute of listPayload(payloadDir).sort()) {
    const rel = absolute.slice(payloadDir.length + 1).split('\\').join('/');
    actual.add(rel);
    if (!declared.has(rel)) {
      problems.push({ code: 'PAYLOAD_FILE_EXTRA', path: rel, message: `${rel} is not declared by the result` });
      continue;
    }
    const expected = result.files.find((file) => file.path === rel);
    if (readFileSync(absolute, 'utf8') !== expected.content) {
      problems.push({ code: 'PAYLOAD_FILE_MISMATCH', path: rel, message: `${rel} bytes differ from the result` });
    }
  }
  for (const path of declared) {
    if (!actual.has(path)) problems.push({ code: 'PAYLOAD_FILE_MISSING', path, message: `${path} is declared but absent from files/` });
  }
  return problems.sort((left, right) => compareCodePoints(left.path, right.path));
}

/**
 * Load `{result, irBytes}` from a result directory or an inline result JSON.
 * Errors are values (`{ok:false, error}`) so the CLI can emit one envelope.
 */
export function loadResultInput({ result: resultPath, ir: irPath }) {
  const absolute = resolve(resultPath);
  if (!existsSync(absolute)) {
    return { ok: false, error: { code: 'RESULT_INPUT_NOT_FOUND', message: `result not found: ${basename(absolute)}`, details: null } };
  }
  const stat = statSync(absolute);
  const directory = stat.isDirectory() ? absolute : dirname(absolute);
  const resultFile = stat.isDirectory() ? join(absolute, 'projection-result.json') : absolute;
  let result;
  try {
    result = JSON.parse(readFileSync(resultFile, 'utf8'));
  } catch (error) {
    return {
      ok: false,
      error: {
        code: error?.code === 'ENOENT' ? 'RESULT_INPUT_NOT_FOUND' : 'RESULT_INPUT_INVALID',
        message: `${basename(resultFile)}: ${error?.code === 'ENOENT' ? 'not found' : 'not valid JSON'}`,
        details: null,
      },
    };
  }
  const irFile = irPath !== undefined
    ? resolve(irPath)
    : [join(directory, 'workflow.ir.json'), join(directory, 'ir', 'workflow.ir.json')]
      .find((candidate) => existsSync(candidate)) ?? null;
  if (irFile === null) {
    return {
      ok: false,
      error: {
        code: 'IR_INPUT_REQUIRED',
        message: 'the result directory must contain workflow.ir.json (or pass --ir)',
        details: null,
      },
    };
  }
  let irBytes;
  try {
    irBytes = readFileSync(irFile);
  } catch {
    return { ok: false, error: { code: 'IR_INPUT_UNREADABLE', message: `${basename(irFile)} is unreadable`, details: null } };
  }
  const payloadDir = join(directory, 'files');
  const problems = payloadProblems(result, payloadDir);
  if (problems.length > 0) {
    return {
      ok: false,
      error: { code: problems[0].code, message: problems[0].message, details: { problems } },
    };
  }
  return { ok: true, result, irBytes };
}

function exitCodeFor(outcome) {
  if (outcome.ok) return EXIT_CODES.OK;
  switch (outcome.code) {
    case 'LOCK_CONFLICT':
      return EXIT_CODES.LOCK;
    case 'NOT_INSTALLED':
      return EXIT_CODES.NO_ACTIVE_RUN;
    case 'UNINSTALL_INCOMPLETE':
      return EXIT_CODES.GATE;
    case 'INTERNAL':
      return EXIT_CODES.INTERNAL;
    default:
      return EXIT_CODES.USAGE;
  }
}

function summaryData(outcome) {
  const receipt = outcome.receipt;
  return {
    action: outcome.action,
    dry_run: outcome.dryRun === true,
    projection: receipt?.projection?.id ?? outcome.projection ?? null,
    bundle: receipt?.bundle?.id ?? outcome.bundle ?? null,
    version: receipt?.bundle?.version ?? outcome.version ?? null,
    mode: outcome.mode ?? receipt?.mode ?? null,
    files: outcome.files ?? receipt?.files?.length ?? null,
    receipt_path: outcome.receiptPath ?? null,
    conflicts: outcome.conflicts ?? undefined,
    diagnostics: outcome.diagnostics ?? undefined,
    warnings: outcome.warnings ?? undefined,
    backups: outcome.backups ?? undefined,
    created_dirs: outcome.createdDirs ?? undefined,
    decisions: outcome.decisions ?? undefined,
    stale: outcome.stale ?? undefined,
    removed: outcome.removed ?? undefined,
    leftover: outcome.leftover ?? undefined,
    pruned: outcome.pruned ?? undefined,
    ir_removed: outcome.irRemoved,
    ignore_suggestions: outcome.ignoreSuggestions ?? undefined,
  };
}

function humanInstall(outcome) {
  const lines = [];
  const receipt = outcome.receipt;
  if (outcome.action === 'unchanged') {
    lines.push(`install ${receipt.projection.id}/${receipt.bundle.id}@${receipt.bundle.version}: unchanged`);
  } else if (outcome.dryRun === true) {
    const writes = (outcome.decisions ?? []).filter((decision) => decision.action !== 'keep' && decision.action !== 'adopt');
    lines.push(`install ${outcome.mode} plan: ${outcome.files} file(s), ${writes.length} write(s), ${outcome.stale?.length ?? 0} remove(s) (dry-run)`);
    for (const decision of outcome.decisions ?? []) lines.push(`  ${decision.action}: ${decision.path}`);
  } else {
    lines.push(`install ${receipt.projection.id}/${receipt.bundle.id}@${receipt.bundle.version}: ${outcome.files} file(s) ${outcome.mode}`);
  }
  for (const warning of outcome.warnings ?? []) lines.push(`warn: ${warning.code}: ${warning.path ?? ''} ${warning.message}`.trim());
  if (Array.isArray(outcome.ignoreSuggestions) && outcome.ignoreSuggestions.length > 0) {
    lines.push(`ignore: add ${outcome.ignoreSuggestions.join(' ')} to .gitignore (the installer never edits it)`);
  }
  return lines.join('\n');
}

function humanUninstall(outcome) {
  const lines = [];
  if (outcome.dryRun === true) {
    lines.push(`uninstall ${outcome.receiptPath}: ${outcome.wouldRemove?.length ?? 0} path(s) would be removed (dry-run)`);
  } else {
    lines.push(`uninstall ${outcome.receiptPath}: ${outcome.removed.length} path(s) removed`);
  }
  for (const warning of outcome.warnings ?? []) lines.push(`warn: ${warning.code}: ${warning.path} ${warning.message}`);
  for (const item of outcome.leftover ?? []) lines.push(`leftover: ${item.path} (${item.reason})`);
  return lines.join('\n');
}

function emit({ json, code, data, error, command = 'install' }) {
  if (json) {
    process.stdout.write(`${JSON.stringify(toEnvelope({ command, code, data, error }))}\n`);
    return code;
  }
  if (error !== null && error !== undefined) process.stderr.write(`error: ${error.message} [${error.code}]\n`);
  return code;
}

export function run(argv, io = {}) {
  const parsed = parseArgs(argv);
  if (parsed.error !== undefined) {
    return emit({ json: argv.includes('--json'), code: EXIT_CODES.USAGE, data: null, error: parsed.error });
  }
  const { options } = parsed;
  const json = options.flags.has('json');
  if (options.flags.has('help')) {
    process.stdout.write(`${USAGE}\n`);
    return EXIT_CODES.OK;
  }
  if (options.flags.has('migrate-legacy')) {
    return emit({
      json,
      code: EXIT_CODES.USAGE,
      data: null,
      error: {
        code: 'LEGACY_MIGRATION_UNSUPPORTED',
        message: '--migrate-legacy lands in #103; use the legacy adapter uninstall first',
        details: null,
      },
    });
  }
  const projectRoot = options.values.project ?? process.cwd();
  const dryRun = options.flags.has('dry-run');
  const force = options.flags.has('force');
  const clock = io.clock;

  if (options.flags.has('status')) {
    const status = installStatus(projectRoot);
    if (json) return emit({ json, command: 'status', code: EXIT_CODES.OK, data: status, error: null });
    process.stdout.write(formatStatus(status));
    return EXIT_CODES.OK;
  }

  if (options.flags.has('doctor')) {
    const report = doctor(projectRoot);
    const code = report.ok ? EXIT_CODES.OK : EXIT_CODES.GATE;
    if (json) {
      return emit({
        json,
        command: 'doctor',
        code,
        data: report,
        error: report.ok ? null : { code: 'DOCTOR_FAILED', message: `${report.summary.fail} check(s) failed`, details: report.checks.filter((item) => item.status === 'fail') },
      });
    }
    process.stdout.write(formatDoctor(report));
    return code;
  }

  if (options.flags.has('uninstall')) {
    const projection = options.values.projection;
    const bundle = options.values.bundle;
    if (projection === undefined || bundle === undefined) {
      return emit({ json, code: EXIT_CODES.USAGE, data: null, error: usageError(USAGE) });
    }
    const outcome = uninstallProjection({
      projectRoot,
      projectionId: projection,
      bundleId: bundle,
      dryRun,
      force,
      clock,
    });
    const code = exitCodeFor(outcome);
    const uninstalled = outcome.code === 'OK' || outcome.code === 'UNINSTALL_INCOMPLETE';
    if (json) {
      return emit({
        json,
        code,
        data: summaryData(outcome),
        error: outcome.code === 'OK' ? null : {
          code: outcome.code,
          message: outcome.message ?? `${outcome.leftover.length} file(s) were modified and kept`,
          details: outcome.failures ?? outcome.leftover ?? null,
        },
      });
    }
    if (uninstalled) process.stdout.write(`${humanUninstall(outcome)}\n`);
    else process.stderr.write(`error: ${outcome.message} [${outcome.code}]\n`);
    return code;
  }

  let runtimeOutcome = null;
  if (options.values.runtime !== undefined) {
    runtimeOutcome = installRuntime({
      projectRoot,
      engineSource: options.values.runtime,
      engineVersion: options.values['engine-version'],
      engineHome: options.values['engine-home'],
      hostTargets: options.values.targets === undefined
        ? undefined
        : String(options.values.targets).split(',').map((target) => target.trim()).filter(Boolean),
      dryRun,
      force,
      clock,
    });
    if (runtimeOutcome.ok === false) {
      return emit({
        json,
        command: 'runtime',
        code: exitCodeFor(runtimeOutcome),
        data: null,
        error: { code: runtimeOutcome.code, message: runtimeOutcome.message, details: runtimeOutcome.conflicts ?? null },
      });
    }
  }

  const resultPath = options.values.result;
  if (resultPath === undefined) {
    if (runtimeOutcome === null) {
      return emit({ json, code: EXIT_CODES.USAGE, data: null, error: usageError(USAGE) });
    }
    const data = {
      action: runtimeOutcome.action,
      dry_run: dryRun,
      engine: runtimeOutcome.engine,
      files: runtimeOutcome.files,
      runtime_path: runtimeOutcome.runtimePath,
      environment: runtimeOutcome.runtime?.merged ?? undefined,
      pruned: runtimeOutcome.pruned ?? undefined,
      wrote: runtimeOutcome.wrote ?? undefined,
    };
    if (json) return emit({ json, command: 'runtime', code: EXIT_CODES.OK, data, error: null });
    process.stdout.write(`runtime/engine/${runtimeOutcome.engine.version}: ${runtimeOutcome.files} file(s) ${runtimeOutcome.action}\n`);
    return EXIT_CODES.OK;
  }
  const loaded = loadResultInput({ result: resultPath, ir: options.values.ir });
  if (!loaded.ok) {
    return emit({ json, code: EXIT_CODES.USAGE, data: null, error: loaded.error });
  }
  const outcome = installR2cProject({
    result: loaded.result,
    irBytes: loaded.irBytes,
    projectRoot,
    dryRun,
    force,
    clock,
  });
  const code = exitCodeFor(outcome);
  if (json) {
    const error = outcome.ok === false
      ? {
        code: outcome.code,
        message: outcome.message,
        details: outcome.conflicts ?? outcome.diagnostics ?? outcome.failures ?? null,
      }
      : null;
    const data = summaryData(outcome);
    if (runtimeOutcome !== null) {
      data.runtime = {
        action: runtimeOutcome.action,
        engine: runtimeOutcome.engine,
        files: runtimeOutcome.files,
        runtime_path: runtimeOutcome.runtimePath,
      };
    }
    return emit({ json, code, data, error, command: 'install' });
  }
  if (outcome.ok === false) {
    process.stderr.write(`error: ${outcome.message} [${outcome.code}]\n`);
    for (const item of outcome.conflicts ?? []) process.stderr.write(`  conflict ${item.code}: ${item.path} — ${item.message}\n`);
    for (const item of outcome.diagnostics ?? []) process.stderr.write(`  ${item.message}\n`);
    return code;
  }
  if (runtimeOutcome !== null) process.stdout.write(`runtime/engine/${runtimeOutcome.engine.version}: ${runtimeOutcome.files} file(s) ${runtimeOutcome.action}\n`);
  process.stdout.write(`${humanInstall(outcome)}\n`);
  return code;
}

const invoked = process.argv[1] === undefined ? '' : resolve(process.argv[1]).toLowerCase();
const self = resolve(fileURLToPath(import.meta.url)).toLowerCase();
if (invoked !== '' && invoked === self) {
  process.exitCode = run(process.argv.slice(2));
}
