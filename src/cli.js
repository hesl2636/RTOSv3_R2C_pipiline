/**
 * r2c command surface.
 *
 * This module is the single owner of argument parsing, the `--json` envelope
 * and the exit-code contract. Agent-facing entry points (hooks, adapters) call
 * the CLI; nothing else parses argv.
 *
 * Exit codes: 0 success / 1 internal error / 2 usage or manifest error /
 * 3 gate or validation failure / 4 no active run or not installed /
 * 5 lock conflict.
 */
import { readFileSync } from 'node:fs';

export const EXIT_OK = 0;
export const EXIT_INTERNAL = 1;
export const EXIT_USAGE = 2;

/** engines.node, kept as one string so package.json and the self-check agree. */
const NODE_RANGE = '>=22.19.0 <23 || >=24.0.0';

const HELP = `Usage: r2c <command> [options]

Global options:
  -h, --help       Show this help and exit.
  -v, --version    Print the runner version and exit.
      --json       Print a single-line JSON envelope on stdout.

No runner commands are implemented in this build.
`;

const PACKAGE_JSON = new URL('../package.json', import.meta.url);

function readVersion() {
  const { version } = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'));
  return version;
}

/** True when `version` (as reported by process.versions.node) is in NODE_RANGE. */
function isSupportedNode(version) {
  const [major, minor] = version.split('.').map((part) => Number.parseInt(part, 10));
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return false;
  if (major === 22) return minor >= 19;
  return major >= 24;
}

/**
 * The unified JSON envelope. Every `--json` response is exactly this shape and
 * exactly one line on stdout.
 */
function envelope({ command = null, code, error = null, data = null }) {
  return {
    ok: error === null,
    command,
    code,
    run_id: null,
    session_id: null,
    step: null,
    data,
    error,
  };
}

function fail({ json, command, code, errorCode, message, details }) {
  const error = { code: errorCode, message, details };
  if (json) {
    process.stdout.write(`${JSON.stringify(envelope({ command, code, error }))}\n`);
  } else {
    process.stderr.write(`r2c: ${message}\n`);
  }
  process.exitCode = code;
}

export async function main(argv) {
  if (!isSupportedNode(process.versions.node)) {
    process.stderr.write(
      `r2c: unsupported Node.js ${process.versions.node}; r2c-runner requires ${NODE_RANGE}\n`,
    );
    process.exitCode = EXIT_INTERNAL;
    return;
  }

  const positionals = [];
  let json = false;
  let help = false;
  let version = false;
  let unknownOption = null;

  for (const arg of argv) {
    if (arg === '--json') json = true;
    else if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--version' || arg === '-v') version = true;
    else if (arg.startsWith('-')) unknownOption ??= arg;
    else positionals.push(arg);
  }

  if (unknownOption !== null) {
    fail({
      json,
      command: positionals[0] ?? null,
      code: EXIT_USAGE,
      errorCode: 'UNKNOWN_OPTION',
      message: `unknown option: ${unknownOption}`,
      details: { option: unknownOption },
    });
    return;
  }

  if (help) {
    process.stdout.write(HELP);
    process.exitCode = EXIT_OK;
    return;
  }

  if (version) {
    process.stdout.write(`${readVersion()}\n`);
    process.exitCode = EXIT_OK;
    return;
  }

  if (positionals.length === 0) {
    process.stdout.write(HELP);
    process.exitCode = EXIT_OK;
    return;
  }

  const command = positionals[0];
  fail({
    json,
    command,
    code: EXIT_USAGE,
    errorCode: 'UNKNOWN_COMMAND',
    message: `unknown command: ${command}`,
    details: { command },
  });
}
