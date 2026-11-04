/** `hm2b-assembler bundle validate <zip> [--json]`. */
import { inflateRaw } from '../../core/node/inflate.js';
import { sha256Hex } from '../../core/node/sha256.js';
import { BUNDLE_SUMMARY_CODE, validateBundle } from '../../assembler/validate-bundle.js';
import {
  EXIT_CODES,
  emitFailure,
  emitReport,
  jsonRequested,
  parseArgs,
  readInput,
  usageError,
} from './common.js';

const COMMAND = 'bundle.validate';

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
    process.stdout.write('Usage: hm2b-assembler bundle validate <bundle.zip> [--json]\n');
    return EXIT_CODES.OK;
  }
  if (options.positionals.length !== 1) {
    return emitFailure({
      json: options.json,
      command: COMMAND,
      code: EXIT_CODES.USAGE,
      error: usageError('usage: bundle validate <bundle.zip>'),
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
  const report = validateBundle(
    input.bytes,
    { inflateRaw, sha256: sha256Hex },
    { path: input.name },
  );
  return emitReport({
    json: options.json,
    command: COMMAND,
    report,
    summaryCode: BUNDLE_SUMMARY_CODE,
  });
}
