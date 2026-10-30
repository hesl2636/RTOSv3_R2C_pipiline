/**
 * Version-set ownership for upgrades and rollbacks (C7).
 *
 * A receipt records the engine home and the payload home it installed; engine,
 * payload and adapters move together. Re-installing at another version replaces
 * the set, and the previous one is removed only when this receipt owned it and
 * no other receipt still references it — one engine and one payload are shared
 * by every adapter in a scope.
 *
 * Anything recursive is deleted only after `isEngineHome`/`isPayloadHome`
 * recognise the directory as `<…>/.r2c/{engine,payload}/<V>`: a receipt is a
 * record, not permission to delete an arbitrary path.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { PAYLOAD_MANIFEST } from '../plugin.js';
import { installDir, stateDir } from './state.js';
import { removePath } from './util.js';

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Every receipt of both scopes, with the state directory it belongs to. */
export function receiptsAcrossScopes(projectRoot) {
  const found = [];
  for (const state of [stateDir('project', projectRoot), stateDir('user', projectRoot)]) {
    const dir = installDir(state);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json') || name.endsWith('.pending.json')) continue;
      const receipt = readJson(join(dir, name));
      // A corrupt receipt is doctor's problem, not ownership's.
      if (receipt !== null && typeof receipt === 'object') found.push({ state, receipt });
    }
  }
  return found;
}

/**
 * The adapter that still references `home`, ignoring the receipt that is being
 * written (`exclude` = `{state, adapter}`), or `null`.
 */
function referencedBy(home, projectRoot, exclude, homeOf) {
  if (typeof home !== 'string' || home === '') return null;
  for (const entry of receiptsAcrossScopes(projectRoot)) {
    if (exclude !== null && entry.state === exclude.state && entry.receipt.adapter === exclude.adapter) continue;
    if (homeOf(entry.receipt) === home) return entry.receipt.adapter;
  }
  return null;
}

export function payloadReferenced(home, projectRoot, exclude = null) {
  return referencedBy(home, projectRoot, exclude, (receipt) => receipt.payload_home);
}

export function engineReferenced(home, projectRoot, exclude = null) {
  return referencedBy(home, projectRoot, exclude, (receipt) => receipt.engine?.home);
}

/** `<…>/.r2c/engine/<V>` whose `package.json` says the same version. */
export function isEngineHome(home, version) {
  if (typeof home !== 'string' || home === '' || typeof version !== 'string') return false;
  if (basename(dirname(home)) !== 'engine') return false;
  if (basename(dirname(dirname(home))) !== '.r2c') return false;
  if (basename(home) !== version) return false;
  if (!existsSync(join(home, 'bin', 'r2c.js'))) return false;
  return readJson(join(home, 'package.json'))?.version === version;
}

/** `<…>/.r2c/payload/<V>` carrying a payload manifest. */
export function isPayloadHome(home, version) {
  if (typeof home !== 'string' || home === '' || typeof version !== 'string') return false;
  if (basename(dirname(home)) !== 'payload') return false;
  if (basename(dirname(dirname(home))) !== '.r2c') return false;
  if (basename(home) !== version) return false;
  return existsSync(join(home, PAYLOAD_MANIFEST));
}

/**
 * What a re-install supersedes: the previous receipt's engine and payload when
 * they differ from the ones just installed and nothing else references them.
 * `current` needs `{state_dir, adapter, engine: {home}, payload_home}`, which a
 * dry-run plan can assemble without writing a receipt.
 */
export function supersededVersionSet({ prior, current, projectRoot }) {
  if (prior === null || prior === undefined) return [];
  const exclude = { state: current.state_dir, adapter: current.adapter };
  const plan = [];
  const engine = prior.engine ?? null;
  if (
    engine !== null &&
    engine.home !== current.engine?.home &&
    isEngineHome(engine.home, engine.version) &&
    engineReferenced(engine.home, projectRoot, exclude) === null
  ) {
    plan.push({ path: engine.home, kind: 'engine' });
  }
  const version = prior.payload?.version;
  if (
    prior.payload_home !== current.payload_home &&
    isPayloadHome(prior.payload_home, version) &&
    payloadReferenced(prior.payload_home, projectRoot, exclude) === null
  ) {
    plan.push({ path: prior.payload_home, kind: 'payload' });
  }
  return plan;
}

export function removeVersionSet(plan) {
  const removed = [];
  const failed = [];
  for (const entry of plan) {
    try {
      removePath(entry.path);
      removed.push(entry.path);
    } catch (error) {
      failed.push({ path: entry.path, error: error.message });
    }
  }
  return { removed, failed };
}
