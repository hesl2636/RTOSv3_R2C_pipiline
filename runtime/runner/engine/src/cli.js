/**
 * hm2b command surface.
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
import { fileURLToPath } from 'node:url';
import { commandNames, loadCommand } from './commands/index.js';
import { EXIT_CODES, Hm2bError, isHm2bError } from './errors.js';
import { normalizeHookInput } from './hook.js';
import { projectRoot as resolveProjectRoot } from './paths.js';

/** Local aliases for the exit-code contract; only `errors.js` owns the values. */
const EXIT_OK = EXIT_CODES.OK;
const EXIT_INTERNAL = EXIT_CODES.INTERNAL;
const EXIT_USAGE = EXIT_CODES.USAGE;

/** engines.node, kept as one string so package.json and the self-check agree. */
const NODE_RANGE = '>=22.19.0 <23 || >=24.0.0';

const HELP = `Usage: hm2b <command> [options]

Commands:
  ${commandNames().join('\n  ')}

Global options:
  -h, --help              Show this help and exit.
  -v, --version           Print the runner version and exit.
      --json              Print a single-line JSON envelope on stdout.
      --project-root DIR  Project whose .hm2b state is used (default: cwd).
      --project DIR       Alias of --project-root on every command.
      --session-id ID     Session routing key.
      --manifest FILE     Absolute workflow manifest path.
      --runner-cmd CMD    Prefix used in rendered Submit lines.
      --retry             resume: re-activate the current failed step.
      --workflow ID       hook stop: only consider this workflow's runs.
      --dry-run           run: discover and validate only, write no state.
`;

const PACKAGE_JSON = new URL('../package.json', import.meta.url);
const BIN_PATH = fileURLToPath(new URL('../bin/hm2b.js', import.meta.url));

const VALUE_OPTIONS = new Set([
  '--project-root',
  '--project',
  '--session-id',
  '--manifest',
  '--runner-cmd',
  '--input',
  '--step',
  '--note',
  '--format',
  '--workflow',
]);

const FLAG_OPTIONS = new Set([
  '--dry-run',
]);

function readPackage() {
  return JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'));
}

function readVersion() {
  return readPackage().version;
}

/** True when `version` (as reported by process.versions.node) is in NODE_RANGE. */
function isSupportedNode(version) {
  const [major, minor] = version.split('.').map((part) => Number.parseInt(part, 10));
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return false;
  if (major === 22) return minor >= 19;
  return major >= 24;
}

/**
 * `--json` detection before the node floor rejects the process.
 *
 * The floor check runs before argv parsing (an unsupported node must fail
 * before any command work), so it cannot rely on the parsed options. It only
 * needs the two spellings `--json` accepts.
 */
function jsonRequested(argv) {
  return argv.includes('--json')
    || argv.some(
      (arg, index) => arg === '--format=json' || (arg === '--format' && argv[index + 1] === 'json'),
    );
}

/**
 * The unified JSON envelope. Every `--json` response is exactly this shape and
 * exactly one line on stdout.
 */
function envelope({ command = null, code, error = null, data = null, runId = null, sessionId = null, step = null }) {
  return {
    ok: error === null,
    command,
    code,
    run_id: runId,
    session_id: sessionId,
    step,
    data,
    error,
  };
}

function writeFailure({ json, command, code, errorCode, message, details = null, data = null, runId = null, sessionId = null, step = null }) {
  const error = { code: errorCode, message, details };
  if (json) {
    process.stdout.write(
      `${JSON.stringify(envelope({ command, code, error, data, runId, sessionId, step }))}\n`,
    );
  } else {
    process.stderr.write(`hm2b: ${message}\n`);
  }
  process.exitCode = code;
}

function parseOptions(argv) {
  const options = {
    json: false,
    help: false,
    version: false,
    retry: false,
    projectRoot: null,
    sessionId: null,
    manifest: null,
    runnerCmd: null,
    input: null,
    step: null,
    note: null,
    format: null,
    dryRun: false,
    provided: [],
    workflow: null,
  };
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--version' || arg === '-v') {
      options.version = true;
      continue;
    }
    if (arg === '--retry') {
      options.retry = true;
      continue;
    }
    if (FLAG_OPTIONS.has(arg)) {
      options.provided.push(arg);
      if (arg === '--dry-run') options.dryRun = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const equals = arg.indexOf('=');
      const name = equals === -1 ? arg : arg.slice(0, equals);
      options.provided.push(name);
      if (!VALUE_OPTIONS.has(name)) {
        return { error: { kind: 'USAGE', message: `unknown option: ${arg}`, details: { option: name } } };
      }
      let value;
      if (equals !== -1) value = arg.slice(equals + 1);
      else {
        value = argv[index + 1];
        if (value === undefined || value.startsWith('--')) {
          return {
            error: { kind: 'USAGE', message: `option requires a value: ${name}`, details: { option: name } },
          };
        }
        index += 1;
      }
      if (name === '--project-root' || name === '--project') options.projectRoot = value;
      else if (name === '--session-id') options.sessionId = value;
      else if (name === '--manifest') options.manifest = value;
      else if (name === '--runner-cmd') options.runnerCmd = value;
      else if (name === '--input') options.input = value;
      else if (name === '--step') options.step = value;
      else if (name === '--note') options.note = value;
      else if (name === '--format') options.format = value;
      else if (name === '--workflow') options.workflow = value;
      continue;
    }
    if (arg.startsWith('-') && arg !== '-') {
      return { error: { kind: 'USAGE', message: `unknown option: ${arg}`, details: { option: arg } } };
    }
    positionals.push(arg);
  }

  if (options.format !== null && options.format !== 'plain' && options.format !== 'json') {
    return {
      error: {
        kind: 'USAGE',
        message: `--format must be "plain" or "json": ${options.format}`,
        details: { option: '--format' },
      },
    };
  }

  return { options, positionals };
}

function firstNonEmpty(...values) {
  return values.find((value) => typeof value === 'string' && value !== '') ?? null;
}

/** Hook stdin is the lowest-priority input source and only for `hook`. */
function readHookInput(command) {
  if (command !== 'hook' || process.stdin.isTTY === true) return null;
  try {
    const raw = readFileSync(0, 'utf8');
    if (raw.trim() === '') return null;
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export async function main(argv) {
  if (!isSupportedNode(process.versions.node)) {
    writeFailure({
      json: jsonRequested(argv),
      command: null,
      code: EXIT_USAGE,
      errorCode: 'NODE_UNSUPPORTED',
      message: `unsupported Node.js ${process.versions.node}; hm2b-runner requires ${NODE_RANGE}`,
      details: { node: process.versions.node, required: NODE_RANGE },
    });
    return;
  }

  const parsed = parseOptions(argv);
  if (parsed.error) {
    writeFailure({
      json: argv.includes('--json'),
      command: null,
      code: EXIT_USAGE,
      errorCode: parsed.error.kind,
      message: parsed.error.message,
      details: parsed.error.details,
    });
    return;
  }

  const { options, positionals } = parsed;
  const json = options.json || options.format === 'json';

  if (options.help) {
    process.stdout.write(HELP);
    process.exitCode = EXIT_OK;
    return;
  }
  if (options.version) {
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
  const hookInput = normalizeHookInput(readHookInput(command));
  const sessionId = firstNonEmpty(
    options.sessionId,
    process.env.HM2B_SESSION_ID,
    process.env.DSH_SESSION_ID,
    hookInput.session_id,
  );
  const rootValue = firstNonEmpty(
    options.projectRoot,
    process.env.HM2B_PROJECT_ROOT,
    hookInput.cwd,
    process.cwd(),
  );
  const projectRoot = resolveProjectRoot(rootValue);

  try {
    const module = await loadCommand(command);
    if (module === null || typeof module.run !== 'function') {
      throw new Hm2bError(
        'UNKNOWN_COMMAND',
        `unknown command: ${command}`,
        { command },
        EXIT_CODES.USAGE,
      );
    }

    const ctx = {
      projectRoot,
      sessionId,
      manifest: options.manifest,
      runnerCmd: options.runnerCmd,
      input: options.input,
      step: options.step,
      note: options.note,
      json,
      format: options.format,
      workflow: options.workflow,
      retry: options.retry,
      version: readVersion(),
      binPath: BIN_PATH,
      options,
      hookInput,
      now: () => new Date(),
    };
    const result = (await module.run(positionals.slice(1), ctx)) ?? {};

    if (result.raw === true) {
      if (typeof result.stdout === 'string') process.stdout.write(result.stdout);
      process.exitCode = typeof result.exitCode === 'number' ? result.exitCode : EXIT_OK;
      return;
    }

    if (json) {
      process.stdout.write(
        `${JSON.stringify(
          envelope({
            command: result.command ?? command,
            code: EXIT_OK,
            data: result.data ?? null,
            runId: result.runId ?? null,
            sessionId: result.sessionId ?? sessionId,
            step: result.step ?? null,
          }),
        )}\n`,
      );
    } else if (typeof result.text === 'string') {
      process.stdout.write(result.text.endsWith('\n') ? result.text : `${result.text}\n`);
    } else if (typeof result.stdout === 'string') {
      process.stdout.write(result.stdout);
    }
    process.exitCode = EXIT_OK;
  } catch (error) {
    if (isHm2bError(error)) {
      writeFailure({
        json,
        command,
        code: error.exitCode,
        errorCode: error.code,
        message: error.message,
        details: error.details,
        data: error.data ?? null,
        runId: error.runId ?? null,
        sessionId: error.sessionId ?? sessionId,
      });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    writeFailure({
      json,
      command,
      code: EXIT_INTERNAL,
      errorCode: 'INTERNAL',
      message,
      details: null,
    });
  }
}
