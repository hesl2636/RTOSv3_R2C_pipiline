#!/usr/bin/env node
/**
 * Framework CLI: `hm2b-assembler`.
 *
 *   bundle validate <zip>     report every bundle problem (exit 0/2)
 *   compiled-workflow validate <file>        validate workflow.compiled.json (exit 0/2)
 *   compile <zip> --out <dir> write workflow.compiled.json (exit 0/2)
 *
 * `--json` prints exactly one envelope line on stdout. Human mode prints
 * diagnostics to stderr and a one-line summary to stdout.
 */
import { EXIT_CODES, emitFailure, jsonRequested, usageError } from './assembler/common.js';
import { run as bundleValidate } from './assembler/bundle-validate.js';
import { run as compile } from './assembler/compile.js';
import { run as compiledWorkflowValidate } from './assembler/compiled-validate.js';
import { run as project } from './assembler/project.js';

const HELP = `Usage: hm2b-assembler <command> [options]

Commands:
  bundle validate <zip>        Validate a hm2b.bundle/v2 archive.
  compiled-workflow validate <file>           Validate a hm2b.compiled-workflow/v2 document.
  compile <zip> --out <dir>    Compile a bundle into workflow.compiled.json.
  project <workflow> --projection <id> [--target <id> ...]
                               [--stage-order a,b] [--skills a,b]
                               [--out <dir>]   Project a compiled workflow into a runtime file set.

A bundle archive may carry knowledge-base/, checklists/, hooks/hooks.json and
mcp.json; compile embeds them in the compiled workflow and the projections
install them.

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
  if (first === 'compiled-workflow' && second === 'validate') return compiledWorkflowValidate(argv.slice(2));
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
