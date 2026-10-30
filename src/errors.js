/**
 * Runner error contract.
 *
 * Every expected failure is an R2cError: `code` is the stable machine-readable
 * identifier carried in the JSON envelope, `exitCode` is the process status
 * from spec §3. Unexpected exceptions are converted to INTERNAL by the CLI.
 */
export const EXIT_CODES = Object.freeze({
  OK: 0,
  INTERNAL: 1,
  USAGE: 2,
  GATE: 3,
  NO_ACTIVE_RUN: 4,
  LOCK: 5,
});

export class R2cError extends Error {
  constructor(code, message, details = null, exitCode = EXIT_CODES.USAGE, data = null) {
    super(message);
    this.name = 'R2cError';
    this.code = code;
    this.details = details;
    this.exitCode = exitCode;
    this.data = data;
  }
}

export function isR2cError(error) {
  return error instanceof R2cError;
}
