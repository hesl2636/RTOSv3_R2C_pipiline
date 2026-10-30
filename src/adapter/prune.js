/**
 * `adapter prune`: remove only engines, payloads, backups and cache entries
 * that no receipt references. Installed versions, receipts and runtime state are
 * never candidates.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { removePath, userHome } from './util.js';
import { stateDir } from './state.js';
import { receiptsAcrossScopes } from './versions.js';

function subdirectories(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export function pruneAdapter({ ctx, options }) {
  const states = [...new Set([stateDir('project', ctx.projectRoot), stateDir('user', ctx.projectRoot)])];
  const receipts = receiptsAcrossScopes(ctx.projectRoot).map((entry) => entry.receipt);
  const referencedHomes = new Set(receipts.map((receipt) => receipt.payload_home).filter(Boolean));
  const referencedEngines = new Set(receipts.map((receipt) => receipt.engine?.home).filter(Boolean));
  const referencedVersions = new Set(
    receipts.map((receipt) => receipt.payload?.version).filter((version) => typeof version === 'string'),
  );
  const backupReferences = receipts.flatMap((receipt) => (receipt.backups ?? []).map((backup) => backup.backup)).filter(Boolean);

  const removed = [];
  const kept = [];
  const plan = [];

  for (const state of states) {
    for (const name of subdirectories(join(state, 'engine'))) {
      const home = join(state, 'engine', name);
      if (referencedEngines.has(home)) {
        kept.push(home);
      } else {
        plan.push({ path: home, kind: 'engine' });
      }
    }
    for (const name of subdirectories(join(state, 'payload'))) {
      const home = join(state, 'payload', name);
      if (referencedHomes.has(home)) {
        kept.push(home);
      } else {
        plan.push({ path: home, kind: 'payload' });
      }
    }
    const backupRoot = join(state, 'install', 'backup');
    for (const agent of subdirectories(backupRoot)) {
      for (const timestamp of subdirectories(join(backupRoot, agent))) {
        const dir = join(backupRoot, agent, timestamp);
        if (backupReferences.some((backup) => backup.startsWith(dir))) {
          kept.push(dir);
        } else {
          plan.push({ path: dir, kind: 'backup' });
        }
      }
    }
  }

  const cacheDir = join(userHome(), '.r2c', 'cache');
  for (const name of subdirectories(cacheDir)) {
    if (!name.startsWith('payload-')) continue;
    const version = name.slice('payload-'.length);
    const dir = join(cacheDir, name);
    if (referencedVersions.has(version)) kept.push(dir);
    else plan.push({ path: dir, kind: 'cache' });
  }

  for (const entry of plan) {
    if (options.dryRun) {
      removed.push(entry.path);
      continue;
    }
    removePath(entry.path);
    removed.push(entry.path);
  }

  return {
    command: 'adapter.prune',
    data: {
      action: options.dryRun ? 'prune' : 'pruned',
      changed: plan.length > 0,
      dry_run: options.dryRun === true,
      removed,
      kept,
      referenced_payloads: [...referencedHomes],
      referenced_engines: [...referencedEngines],
      referenced_versions: [...referencedVersions],
    },
  };
}
