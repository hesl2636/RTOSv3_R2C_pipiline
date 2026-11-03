/** `hm2b-assembler compiled-workflow validate <workflow.compiled.json> [--json]`. */
import { sha256Hex } from '../../core/node/sha256.js';
import { COMPILED_WORKFLOW_SUMMARY_CODE, validateCompiledWorkflow } from '../../assembler/validate-compiled.js';
import {
  EXIT_CODES,
  emitFailure,
  emitReport,
  jsonRequested,
  parseArgs,
  readInput,
  usageError,
} from './common.js';

const COMMAND = 'compiled-workflow.validate';

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
    process.stdout.write('Usage: hm2b-assembler compiled-workflow validate <workflow.compiled.json> [--json]\n');
    return EXIT_CODES.OK;
  }
  if (options.positionals.length !== 1) {
    return emitFailure({
      json: options.json,
      command: COMMAND,
      code: EXIT_CODES.USAGE,
      error: usageError('usage: compiled-workflow validate <workflow.compiled.json>'),
    });
  }
  const input = readInput(options.positionals[0], {
    notFound: 'COMPILED_WORKFLOW_INPUT_NOT_FOUND',
    unreadable: 'COMPILED_WORKFLOW_INPUT_UNREADABLE',
  });
  if (!input.ok) {
    return emitFailure({
      json: options.json,
      command: COMMAND,
      code: EXIT_CODES.USAGE,
      error: input.error,
    });
  }
  const report = validateCompiledWorkflow(input.bytes, { sha256: sha256Hex });
  return emitReport({
    json: options.json,
    command: COMMAND,
    report,
    summaryCode: COMPILED_WORKFLOW_SUMMARY_CODE,
  });
}
