/**
 * `r2c adapter` dispatch. One installer, five declarative adapters.
 */
import { EXIT_CODES, R2cError } from '../errors.js';
import { doctorAdapter } from './doctor.js';
import { installAdapter } from './install.js';
import { listAdapters } from './list.js';
import { pruneAdapter } from './prune.js';
import { runAdapterSmoke } from './smoke.js';
import { receiptPath, stateDir } from './state.js';
import { uninstallAdapter } from './uninstall.js';
import { readJsonIfExists } from './util.js';

function usage(message, details = null) {
  return new R2cError('USAGE', message, details, EXIT_CODES.USAGE);
}

function requireAgent(agentId) {
  if (typeof agentId !== 'string' || agentId === '') {
    throw usage('adapter <agent> is required', { hint: 'try "r2c adapter list"' });
  }
  return agentId;
}

function smokeAdapter({ ctx, agentId, options }) {
  let scope = options.scope ?? null;
  if (scope === null) {
    scope = readJsonIfExists(receiptPath(stateDir('project', ctx.projectRoot), agentId)) !== null
      ? 'project'
      : 'user';
  }
  const receipt = readJsonIfExists(receiptPath(stateDir(scope, ctx.projectRoot), agentId));
  if (receipt === null) {
    throw new R2cError(
      'NOT_INSTALLED',
      `adapter ${agentId} is not installed (${scope} scope)`,
      { adapter: agentId, scope },
      EXIT_CODES.NO_ACTIVE_RUN,
    );
  }
  const result = runAdapterSmoke({
    payloadHome: receipt.payload_home,
    agentId,
    scope,
    projectRoot: ctx.projectRoot,
  });
  const data = {
    adapter: agentId,
    scope,
    ok: result.ok,
    available: result.available,
    detail: result.detail,
    found: result.result?.found ?? null,
    missing: result.result?.missing ?? [],
  };
  if (!result.available) {
    throw new R2cError(
      'SMOKE_UNAVAILABLE',
      `adapter ${agentId} has no smoke.mjs in its payload`,
      { adapter: agentId, payload_home: receipt.payload_home },
      EXIT_CODES.GATE,
      data,
    );
  }
  if (result.available && !result.ok) {
    throw new R2cError(
      'SMOKE_FAILED',
      `adapter smoke failed: ${result.detail ?? 'unknown error'}`,
      { adapter: agentId, detail: result.detail },
      EXIT_CODES.GATE,
      data,
    );
  }
  return { command: 'adapter.smoke', data };
}

export async function runAdapter(argv, ctx) {
  const [action, ...rest] = argv;
  const options = { ...(ctx.options ?? {}) };
  const agentId = rest[0] ?? options.agent ?? null;

  switch (action) {
    case 'list':
      return listAdapters({ ctx, options });
    case 'install':
      return installAdapter({
        ctx,
        agentId: requireAgent(agentId),
        options: { ...options, agentExplicit: options.agent !== undefined && rest.length === 0 },
      });
    case 'uninstall':
      return uninstallAdapter({ ctx, agentId: requireAgent(agentId), options });
    case 'doctor':
      return doctorAdapter({ ctx, agentId: requireAgent(agentId), options });
    case 'smoke':
      return smokeAdapter({ ctx, agentId: requireAgent(agentId), options });
    case 'prune':
      return pruneAdapter({ ctx, options });
    case undefined:
      throw usage('adapter subcommand is required', {
        subcommands: ['list', 'install', 'uninstall', 'doctor', 'smoke', 'prune'],
      });
    default:
      throw usage(`unknown adapter subcommand: ${action}`, {
        subcommand: action,
        supported: ['list', 'install', 'uninstall', 'doctor', 'smoke', 'prune'],
      });
  }
}
