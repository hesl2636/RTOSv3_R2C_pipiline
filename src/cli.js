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
import { fileURLToPath } from 'node:url';
import { commandNames, loadCommand } from './commands/index.js';
import { EXIT_CODES, R2cError, isR2cError } from './errors.js';
import { normalizeHookInput } from './hook.js';
import { projectRoot as resolveProjectRoot } from './paths.js';

/** Local aliases for the exit-code contract; only `errors.js` owns the values. */
const EXIT_OK = EXIT_CODES.OK;
const EXIT_INTERNAL = EXIT_CODES.INTERNAL;
const EXIT_USAGE = EXIT_CODES.USAGE;

/** engines.node, kept as one string so package.json and the self-check agree. */
const NODE_RANGE = '>=22.19.0 <23 || >=24.0.0';

const HELP = `Usage: r2c <command> [options]

Commands:
  ${commandNames().join('\n  ')}

Global options:
  -h, --help              Show this help and exit.
  -v, --version           Print the runner version and exit.
      --json              Print a single-line JSON envelope on stdout.
      --project-root DIR  Project whose .r2c state is used (default: cwd).
      --project DIR       Alias of --project-root on every command.
      --session-id ID     Session routing key.
      --manifest FILE     Absolute workflow manifest path.
      --runner-cmd CMD    Prefix used in rendered Submit lines.
      --retry             resume: re-activate the current failed step.
      --workflow ID       hook stop: only consider this workflow's runs.
      --dry-run           run: discover and validate only, write no state.

Adapter options:
      --from PATH         Payload directory or r2c-payload-<V>.tgz archive.
      --scope SCOPE       project | user (default from adapter.json).
      --plugin VERSION    Payload version for cache lookup (default: engine).
      --mcp FILE          Merge mcpServers from FILE into the agent config.
      --force             Back up and replace conflicting files.
      --dry-run           Print the plan without writing anything.
      --copy / --link     Install mode; --link requires --from.
      --no-smoke          Skip the post-install discovery probe.
      --profile NAME      Agent profile (dsh: default "web").
      --engine DIR        Engine home recorded in the receipt (default:
                          R2C_ENGINE_HOME, else the running engine's root).
      --purge-state       uninstall: also remove .r2c runtime state.

Acceptance options:
      --keep              Keep the temporary sandbox and print its path.
      --only ID[,ID]      Run only the named checks.
`;

const PACKAGE_JSON = new URL('../package.json', import.meta.url);
const BIN_PATH = fileURLToPath(new URL('../bin/r2c.js', import.meta.url));

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
  '--from',
  '--scope',
  '--plugin',
  '--mcp',
  '--agent',
  '--workflow',
  '--profile',
  '--only',
  '--engine',
]);

const FLAG_OPTIONS = new Set([
  '--force',
  '--dry-run',
  '--no-smoke',
  '--purge-state',
  '--copy',
  '--link',
  '--keep',
]);

function readPackage() {
  return JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'));
}

function readVersion() {
  return readPackage().version;
}

function readPackageName() {
  return readPackage().name;
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
    process.stderr.write(`r2c: ${message}\n`);
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
    from: null,
    scope: null,
    plugin: null,
    mcp: null,
    agent: null,
    profile: null,
    force: false,
    dryRun: false,
    noSmoke: false,
    purgeState: false,
    copy: false,
    link: false,
    keep: false,
    only: null,
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
      if (arg === '--force') options.force = true;
      else if (arg === '--dry-run') options.dryRun = true;
      else if (arg === '--no-smoke') options.noSmoke = true;
      else if (arg === '--purge-state') options.purgeState = true;
      else if (arg === '--copy') options.copy = true;
      else if (arg === '--link') options.link = true;
      else if (arg === '--keep') options.keep = true;
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
      else if (name === '--from') options.from = value;
      else if (name === '--scope') options.scope = value;
      else if (name === '--plugin') options.plugin = value;
      else if (name === '--mcp') options.mcp = value;
      else if (name === '--agent') options.agent = value;
      else if (name === '--profile') options.profile = value;
      else if (name === '--engine') options.engine = value;
      else if (name === '--workflow') options.workflow = value;
      else if (name === '--only') options.only = value;
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
      message: `unsupported Node.js ${process.versions.node}; r2c-runner requires ${NODE_RANGE}`,
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
  const ADAPTER_ONLY = new Set([
    '--from',
    '--scope',
    '--plugin',
    '--mcp',
    '--agent',
    '--profile',
    '--force',
    '--dry-run',
    '--no-smoke',
    '--purge-state',
    '--copy',
    '--link',
    '--engine',
  ]);
  const ACCEPTANCE_ONLY = new Set(['--keep', '--only']);
  let foreign = null;
  const adapterOnly = (option) => ADAPTER_ONLY.has(option)
    && !(option === '--dry-run' && command === 'run');
  if (command !== 'adapter' && command !== 'acceptance') {
    foreign = (options.provided ?? []).find(adapterOnly);
  } else if (command === 'acceptance') {
    foreign = (options.provided ?? []).find(
      (option) => ADAPTER_ONLY.has(option) && option !== '--agent',
    );
  }
  if (foreign === null && command !== 'acceptance') {
    foreign = (options.provided ?? []).find((option) => ACCEPTANCE_ONLY.has(option));
  }
  if (foreign !== null && foreign !== undefined) {
    writeFailure({
      json,
      command,
      code: EXIT_USAGE,
      errorCode: 'USAGE',
      message: `unknown option: ${foreign}`,
      details: { option: foreign },
    });
    return;
  }
  const hookInput = normalizeHookInput(readHookInput(command));
  const sessionId = firstNonEmpty(
    options.sessionId,
    process.env.R2C_SESSION_ID,
    process.env.DSH_SESSION_ID,
    hookInput.session_id,
  );
  const rootValue = firstNonEmpty(
    options.projectRoot,
    process.env.R2C_PROJECT_ROOT,
    hookInput.cwd,
    process.cwd(),
  );
  const projectRoot = resolveProjectRoot(rootValue);

  try {
    const module = await loadCommand(command);
    if (module === null || typeof module.run !== 'function') {
      throw new R2cError(
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
      packageName: readPackageName(),
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
    if (isR2cError(error)) {
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
