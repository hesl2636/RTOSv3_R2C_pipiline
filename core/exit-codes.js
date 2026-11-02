/**
 * Process exit-code contract, shared by the framework CLI and the legacy
 * runner. Values are frozen: 0 success (warnings included) / 1 internal bug /
 * 2 usage or input invalid / 3 gate / 4 no active run / 5 lock.
 *
 * This module is a pure mirror of `src/errors.js`; the two must stay equal
 * until the legacy engine is ported.
 */
export const EXIT_CODES = Object.freeze({
  OK: 0,
  INTERNAL: 1,
  USAGE: 2,
  GATE: 3,
  NO_ACTIVE_RUN: 4,
  LOCK: 5,
});
