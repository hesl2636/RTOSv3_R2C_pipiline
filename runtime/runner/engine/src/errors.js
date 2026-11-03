/**
 * Runner error contract.
 *
 * Every expected failure is an Hm2bError: `code` is the stable machine-readable
 * identifier carried in the JSON envelope, `exitCode` is the process status
 * from spec §3. Unexpected exceptions are converted to INTERNAL by the CLI.
 * The values themselves live in `core/exit-codes.js`, shared with the
 * framework CLI.
 */
import { EXIT_CODES } from '../../../../core/exit-codes.js';

export { EXIT_CODES };

export class Hm2bError extends Error {
  constructor(code, message, details = null, exitCode = EXIT_CODES.USAGE, data = null) {
    super(message);
    this.name = 'Hm2bError';
    this.code = code;
    this.details = details;
    this.exitCode = exitCode;
    this.data = data;
  }
}

export function isHm2bError(error) {
  return error instanceof Hm2bError;
}
