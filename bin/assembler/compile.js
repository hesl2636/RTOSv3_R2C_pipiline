/** `r2c-assembler compile <bundle.zip> --out <dir> [--json]`. */
import { join } from 'node:path';
import { inflateRaw } from '../../core/node/inflate.js';
import { sha256Hex } from '../../core/node/sha256.js';
import { atomicWriteFile } from '../../core/node/atomic-write.js';
import { IR_FILENAME, irCollectionPath } from '../../ir/schema.js';
import { compileBundle } from '../../assembler/compile.js';
import { BUNDLE_SUMMARY_CODE } from '../../assembler/validate-bundle.js';
import { IR_SUMMARY_CODE } from '../../assembler/validate-ir.js';
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
    process.stdout.write('Usage: r2c-assembler compile <bundle.zip> --out <dir> [--json]\n');
    return EXIT_CODES.OK;
  }
  if (options.positionals.length !== 1 || options.out === null) {
    return emitFailure({
      json: options.json,
      command: COMMAND,
      code: EXIT_CODES.USAGE,
      error: usageError('usage: compile <bundle.zip> --out <dir>'),
    });
  }
  const input = readInput(options.positionals[0], {
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
      summaryCode: result.report.target === 'ir' ? IR_SUMMARY_CODE : BUNDLE_SUMMARY_CODE,
    });
  }

  const target = join(options.out, IR_FILENAME);
  try {
    atomicWriteFile(target, result.irBytes);
  } catch {
    return emitFailure({
      json: options.json,
      command: COMMAND,
      code: EXIT_CODES.USAGE,
      error: {
        code: 'OUTPUT_UNWRITABLE',
        message: `could not write ${IR_FILENAME} under the requested directory`,
        details: { path: IR_FILENAME },
      },
    });
  }

  const ir = {
    path: irCollectionPath(result.irReport.id, result.irReport.version),
    bytes: result.irBytes.length,
    sha256: result.digest,
  };
  if (!options.json) {
    for (const warning of result.report.warnings) {
      process.stderr.write(`${formatDiagnostic(warning)}\n`);
    }
    process.stdout.write(`${IR_FILENAME} written: ${IR_FILENAME} (${ir.bytes} bytes, sha256 ${ir.sha256})\n`);
    return EXIT_CODES.OK;
  }
  return emitReport({
    json: true,
    command: COMMAND,
    report: result.report,
    data: { report: result.report, ir },
    summaryCode: BUNDLE_SUMMARY_CODE,
  });
}
