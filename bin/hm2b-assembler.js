#!/usr/bin/env node
/**
 * Framework CLI: `hm2b-assembler`.
 *
 *   bundle validate <zip>     report every bundle problem (exit 0/2)
 *   ir validate <file>        validate workflow.ir.json (exit 0/2)
 *   compile <zip> --out <dir> write workflow.ir.json (exit 0/2)
 *
 * `--json` prints exactly one envelope line on stdout. Human mode prints
 * diagnostics to stderr and a one-line summary to stdout.
 */
import { EXIT_CODES, emitFailure, jsonRequested, usageError } from './assembler/common.js';
import { run as bundleValidate } from './assembler/bundle-validate.js';
import { run as compile } from './assembler/compile.js';
import { run as irValidate } from './assembler/ir-validate.js';
import { run as project } from './assembler/project.js';

const HELP = `Usage: hm2b-assembler <command> [options]

Commands:
  bundle validate <zip>        Validate a hm2b.bundle/v1 archive.
  ir validate <file>           Validate a hm2b.ir/v1 document.
  compile <zip> --out <dir>    Compile a bundle into workflow.ir.json.
  project <ir> --projection <id> [--target <id> ...]
                               [--stage-order a,b] [--skills a,b]
                               [--out <dir>]   Project an IR into a runtime file set.

Global options:
  -h, --help                   Show this help and exit.
      --json                   Print a single-line JSON envelope on stdout.
      --out DIR                Output directory for compile/project.
`;

function dispatch(argv) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(HELP);
    return EXIT_CODES.OK;
  }
  const [first, second] = argv;
  if (first === 'bundle' && second === 'validate') return bundleValidate(argv.slice(2));
  if (first === 'ir' && second === 'validate') return irValidate(argv.slice(2));
  if (first === 'compile') return compile(argv.slice(1));
  if (first === 'project') return project(argv.slice(1));
  return emitFailure({
    json: jsonRequested(argv),
    command: [first, second].filter(Boolean).join('.') || null,
    code: EXIT_CODES.USAGE,
    error: usageError(`unknown command: ${[first, second].filter(Boolean).join(' ')}`),
  });
}

try {
  const code = dispatch(process.argv.slice(2));
  if (typeof code === 'number') process.exitCode = code;
} catch (error) {
  const json = jsonRequested(process.argv.slice(2));
  const message = error instanceof Error ? error.message : String(error);
  emitFailure({
    json,
    command: null,
    code: EXIT_CODES.INTERNAL,
    error: { code: 'INTERNAL', message, details: null },
  });
}
