/** `hm2b-assembler compile <bundle.zip|bundle-dir> --out <dir> [--json]`. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { inflateRaw } from '../../core/node/inflate.js';
import { sha256Hex } from '../../core/node/sha256.js';
import { atomicWriteFile } from '../../core/node/atomic-write.js';
import { COMPILED_WORKFLOW_FILENAME } from '../../compiled/schema.js';
import { compileBundle } from '../../assembler/compile.js';
import { writeZip } from '../../assembler/zip.js';
import { BUNDLE_SUMMARY_CODE } from '../../assembler/validate-bundle.js';
import { COMPILED_WORKFLOW_SUMMARY_CODE } from '../../assembler/validate-compiled.js';
import {
  EXIT_CODES,
  emitFailure,
  emitReport,
  formatDiagnostic,
  jsonRequested,
  parseArgs,
  readInput,
  usageError,
} from './common.js';

const COMMAND = 'compile';

function unreadable(path, error, codes) {
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

/**
 * Read an unpacked bundle directory into the same in-memory zip the CLI would
 * otherwise receive, so both shapes run through one container pipeline (#92).
 */
function readDirectoryInput(path, codes) {
  const files = [];
  const walk = (absolute, prefix) => {
    for (const name of readdirSync(absolute)) {
      const child = join(absolute, name);
      const stat = statSync(child);
      if (stat.isDirectory()) {
        files.push({ path: `${prefix}${name}/`, data: new Uint8Array(0) });
        walk(child, `${prefix}${name}/`);
      } else if (stat.isFile()) {
        files.push({ path: `${prefix}${name}`, data: new Uint8Array(readFileSync(child)) });
      }
    }
  };
  try {
    walk(path, '');
    return { ok: true, bytes: writeZip(files), name: basename(path) || 'bundle' };
  } catch (error) {
    return unreadable(path, error, codes);
  }
}

function readBundleInput(path, codes) {
  try {
    if (statSync(path).isDirectory()) return readDirectoryInput(path, codes);
  } catch {
    // Fall through: `readInput` maps a missing/unreadable input to its code.
  }
  return readInput(path, codes);
}

export function run(argv) {
  const parsed = parseArgs(argv);
  if (parsed.error !== undefined) {
    return emitFailure({
      json: jsonRequested(argv),
      command: COMMAND,
      code: EXIT_CODES.USAGE,
      error: parsed.error,
    });
  }
  const { options } = parsed;
  if (options.help) {
    process.stdout.write('Usage: hm2b-assembler compile <bundle.zip|bundle-dir> --out <dir> [--json]\n');
    return EXIT_CODES.OK;
  }
  if (options.positionals.length !== 1 || options.out === null) {
    return emitFailure({
      json: options.json,
      command: COMMAND,
      code: EXIT_CODES.USAGE,
      error: usageError('usage: compile <bundle.zip|bundle-dir> --out <dir>'),
    });
  }
  const input = readBundleInput(options.positionals[0], {
    notFound: 'BUNDLE_INPUT_NOT_FOUND',
    unreadable: 'BUNDLE_INPUT_UNREADABLE',
  });
  if (!input.ok) {
    return emitFailure({
      json: options.json,
      command: COMMAND,
      code: EXIT_CODES.USAGE,
      error: input.error,
    });
  }

  const result = compileBundle(
    input.bytes,
    { inflateRaw, sha256: sha256Hex },
    { path: input.name },
  );
  if (!result.ok) {
    return emitReport({
      json: options.json,
      command: COMMAND,
      report: result.report,
      summaryCode: result.report.target === 'compiled-workflow' ? COMPILED_WORKFLOW_SUMMARY_CODE : BUNDLE_SUMMARY_CODE,
    });
  }

  const target = join(options.out, COMPILED_WORKFLOW_FILENAME);
  try {
    atomicWriteFile(target, result.compiledWorkflowBytes);
  } catch {
    return emitFailure({
      json: options.json,
      command: COMMAND,
      code: EXIT_CODES.USAGE,
      error: {
        code: 'OUTPUT_UNWRITABLE',
        message: `could not write ${COMPILED_WORKFLOW_FILENAME} under the requested directory`,
        details: { path: COMPILED_WORKFLOW_FILENAME },
      },
    });
  }

  const compiledWorkflow = {
    path: COMPILED_WORKFLOW_FILENAME,
    bytes: result.compiledWorkflowBytes.length,
    sha256: result.digest,
  };
  if (!options.json) {
    for (const warning of result.report.warnings) {
      process.stderr.write(`${formatDiagnostic(warning)}\n`);
    }
    process.stdout.write(`${COMPILED_WORKFLOW_FILENAME} written: ${COMPILED_WORKFLOW_FILENAME} (${compiledWorkflow.bytes} bytes, sha256 ${compiledWorkflow.sha256})\n`);
    return EXIT_CODES.OK;
  }
  return emitReport({
    json: true,
    command: COMMAND,
    report: result.report,
    data: { ...result.report, compiledWorkflow },
    summaryCode: BUNDLE_SUMMARY_CODE,
  });
}
