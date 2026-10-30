/**
 * `adapter prune`: remove only payloads, backups and cache entries that no
 * receipt references. Installed versions, receipts and runtime state are never
 * candidates.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { removePath, userHome } from './util.js';
import { installDir, stateDir } from './state.js';

function receiptFiles(state) {
  const dir = join(installDir(state));
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json') && !name.endsWith('.pending.json'))
    .map((name) => {
      try {
        return JSON.parse(readFileSync(join(dir, name), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function subdirectories(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export function pruneAdapter({ ctx, options }) {
  const states = [...new Set([stateDir('project', ctx.projectRoot), stateDir('user', ctx.projectRoot)])];
  const receipts = states.flatMap((state) => receiptFiles(state));
  const referencedHomes = new Set(receipts.map((receipt) => receipt.payload_home).filter(Boolean));
  const referencedVersions = new Set(
    receipts.map((receipt) => receipt.payload?.version).filter((version) => typeof version === 'string'),
  );
  const backupReferences = receipts.flatMap((receipt) => (receipt.backups ?? []).map((backup) => backup.backup)).filter(Boolean);

  const removed = [];
  const kept = [];
  const plan = [];

  for (const state of states) {
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
      referenced_versions: [...referencedVersions],
    },
  };
}
