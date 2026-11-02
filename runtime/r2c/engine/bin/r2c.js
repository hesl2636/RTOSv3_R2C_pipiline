#!/usr/bin/env node
/**
 * r2c entry point.
 *
 * A thin shim: everything (argument parsing, envelopes, exit codes) lives in
 * src/cli.js so the package has exactly one implementation of the command
 * surface.
 */
import { main } from '../src/cli.js';

try {
  await main(process.argv.slice(2));
} catch (error) {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`r2c: internal error\n${detail}\n`);
  process.exitCode = 1;
}
