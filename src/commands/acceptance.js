/**
 * `r2c acceptance` command module. Parsing stays in `src/cli.js`; the
 * aggregator owns the checks, the sandbox and the envelope data.
 */
import { runAcceptance } from '../acceptance/index.js';

export async function run(argv, ctx) {
  return runAcceptance(argv, ctx);
}
