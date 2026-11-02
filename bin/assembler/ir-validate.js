/** `r2c-assembler ir validate <workflow.ir.json> [--json]`. */
import { sha256Hex } from '../../core/node/sha256.js';
import { IR_SUMMARY_CODE, validateIr } from '../../assembler/validate-ir.js';
import {
  EXIT_CODES,
  emitFailure,
  emitReport,
  jsonRequested,
  parseArgs,
  readInput,
  usageError,
} from './common.js';

const COMMAND = 'ir.validate';

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
    process.stdout.write('Usage: r2c-assembler ir validate <workflow.ir.json> [--json]\n');
    return EXIT_CODES.OK;
  }
  if (options.positionals.length !== 1) {
    return emitFailure({
      json: options.json,
      command: COMMAND,
      code: EXIT_CODES.USAGE,
      error: usageError('usage: ir validate <workflow.ir.json>'),
    });
  }
  const input = readInput(options.positionals[0], {
    notFound: 'IR_INPUT_NOT_FOUND',
    unreadable: 'IR_INPUT_UNREADABLE',
  });
  if (!input.ok) {
    return emitFailure({
      json: options.json,
      command: COMMAND,
      code: EXIT_CODES.USAGE,
      error: input.error,
    });
  }
  const report = validateIr(input.bytes, { sha256: sha256Hex });
  return emitReport({
    json: options.json,
    command: COMMAND,
    report,
    summaryCode: IR_SUMMARY_CODE,
  });
}
