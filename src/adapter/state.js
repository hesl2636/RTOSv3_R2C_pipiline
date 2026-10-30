/**
 * Installer state paths. Receipts, backups, pending markers and the install
 * lock all live next to the runtime state so `adapter uninstall`/`doctor` and
 * `prune` can find them without scanning agent directories.
 */
import { join } from 'node:path';
import { userHome } from './util.js';

export function stateDir(scope, projectRoot) {
  return scope === 'user' ? join(userHome(), '.r2c') : join(projectRoot, '.r2c');
}

export function installDir(state) {
  return join(state, 'install');
}

export function receiptPath(state, agentId) {
  return join(installDir(state), `${agentId}.json`);
}

export function pendingPath(state, agentId) {
  return join(installDir(state), `${agentId}.pending.json`);
}

export function installLockPath(state) {
  return join(installDir(state), '.lock');
}

export function backupDir(state, agentId, timestamp) {
  return join(installDir(state), 'backup', agentId, timestamp);
}

export function timestampSlug(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}
