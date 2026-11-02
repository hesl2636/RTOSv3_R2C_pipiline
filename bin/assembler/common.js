/**
 * Shared framework-CLI plumbing: argv, input reading, diagnostics formatting
 * and the single `--json` envelope (same shape as `src/cli.js`, no imports
 * from the legacy engine).
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { EXIT_CODES } from '../../core/exit-codes.js';
import { reportFailureSummary, toEnvelope } from '../../core/diagnostics.js';

export { EXIT_CODES };

export function jsonRequested(argv) {
  return argv.includes('--json')
    || argv.some((arg, index) => arg === '--format=json'
      || (arg === '--format' && argv[index + 1] === 'json'));
}

export function writeEnvelope(envelope) {
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

export function usageError(message) {
  return { code: 'USAGE', message, details: null };
}

/** Parse the shared flags; unknown flags are a usage error. */
export function parseArgs(argv) {
  const options = { json: false, out: null, help: false, positionals: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--format=json') {
      options.json = true;
    } else if (arg === '--format') {
      if (argv[index + 1] !== 'json') return { error: usageError('unsupported --format value') };
      options.json = true;
      index += 1;
    } else if (arg === '--out') {
      if (argv[index + 1] === undefined) return { error: usageError('--out requires a directory') };
      options.out = argv[index + 1];
      index += 1;
    } else if (arg.startsWith('--out=')) {
      options.out = arg.slice('--out='.length);
      if (options.out === '') return { error: usageError('--out requires a directory') };
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--') {
      options.positionals.push(...argv.slice(index + 1));
      break;
    } else if (arg.startsWith('-')) {
      return { error: usageError(`unknown option: ${arg}`) };
    } else {
      options.positionals.push(arg);
    }
  }
  return { options };
}

/**
 * Read an input file. Failures are mapped to the documented input codes; the
 * report/envelope never contains an absolute path.
 */
export function readInput(path, codes) {
  try {
    return { ok: true, bytes: new Uint8Array(readFileSync(path)), name: basename(path) };
  } catch (error) {
    const missing = error?.code === 'ENOENT';
    return {
      ok: false,
      error: {
        code: missing ? codes.notFound : codes.unreadable,
        message: missing ? `input not found: ${basename(path)}` : `input is not readable: ${basename(path)}`,
        details: missing ? { path: basename(path) } : { path: basename(path), reason: error?.code ?? 'io' },
      },
    };
  }
}

function location(diagnostic) {
  if (diagnostic.path === '') return '';
  if (diagnostic.line !== null && diagnostic.line !== undefined) return `${diagnostic.path}:${diagnostic.line}`;
  if (diagnostic.pointer !== null && diagnostic.pointer !== undefined) return `${diagnostic.path}${diagnostic.pointer}`;
  return diagnostic.path;
}

export function formatDiagnostic(diagnostic) {
  const where = location(diagnostic);
  const prefix = where === '' ? '' : `${where}: `;
  return `${diagnostic.severity}: ${prefix}${diagnostic.message} [${diagnostic.code}]`;
}

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export function summaryLine(report) {
  const state = report.ok ? 'valid' : 'invalid';
  const counts = report.counts;
  const parts = [
    plural(counts.stages, 'stage'),
    plural(counts.steps, 'step'),
    plural(counts.roles, 'role'),
    plural(counts.tasks, 'task'),
    plural(counts.skills, 'skill'),
  ];
  if (counts.constitutions > 0) parts.push(plural(counts.constitutions, 'constitution'));
  parts.push(plural(counts.errors, 'error'), plural(counts.warnings, 'warning'));
  return `${report.target} ${state}: ${report.artifact.path} (${parts.join(', ')})`;
}

/**
 * Emit a report as either one JSON envelope line or human diagnostics.
 * Returns the exit code (0 valid, 2 invalid).
 */
export function emitReport({ json, command, report, data = report, summaryCode }) {
  const code = report.ok ? EXIT_CODES.OK : EXIT_CODES.USAGE;
  if (json) {
    const error = report.ok ? null : reportFailureSummary(report, summaryCode);
    writeEnvelope(toEnvelope({ command, code, data, error }));
    return code;
  }
  for (const diagnostic of [...report.errors, ...report.warnings]) {
    process.stderr.write(`${formatDiagnostic(diagnostic)}\n`);
  }
  process.stdout.write(`${summaryLine(report)}\n`);
  return code;
}

/** Emit a non-report failure (usage, unreadable input, output error). */
export function emitFailure({ json, command, code, error, data = null }) {
  if (json) {
    writeEnvelope(toEnvelope({ command, code, data, error }));
  } else {
    process.stderr.write(`error: ${error.message} [${error.code}]\n`);
  }
  return code;
}
