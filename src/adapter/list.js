/**
 * `adapter list`: the adapter matrix as data, read from each `adapter.json`.
 *
 * Sources, in order: `--from <payload>` (or `R2C_PLUGIN_SOURCE`), the checkout
 * that ships this engine, then every installed payload. Adapters have no
 * version of their own (#11 §1.1), so `version` is the payload version.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT_CODES, R2cError } from '../errors.js';
import { isValidRange, satisfies } from '../version.js';
import { resolvePayload } from './payload.js';
import { receiptPath, stateDir } from './state.js';
import { readJsonIfExists } from './util.js';

const REPO_ADAPTERS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'adapters');

function readDeclaration(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function adapterDirs(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name))
    .filter((dir) => existsSync(join(dir, 'adapter.json')))
    .sort();
}

function installedScopes(agentId, projectRoot) {
  const scopes = [];
  for (const scope of ['project', 'user']) {
    if (readJsonIfExists(receiptPath(stateDir(scope, projectRoot), agentId)) !== null) scopes.push(scope);
  }
  return scopes;
}

function toRow(adapter, { version, source, projectRoot }) {
  const engineRange = adapter.requires?.engine ?? null;
  const installed = installedScopes(adapter.id, projectRoot);
  return {
    id: adapter.id,
    title: adapter.title ?? adapter.id,
    version: version ?? null,
    engine: engineRange,
    engine_satisfied: engineRange === null ? null : isValidRange(engineRange) && satisfies(version ?? '0.0.0', engineRange),
    agent: adapter.requires?.agent ?? null,
    scopes: adapter.scopes ?? [],
    defaults: adapter.defaults ?? {},
    installed: installed.length > 0,
    installed_scopes: installed,
    source,
  };
}

function installedPayloadRoots(projectRoot) {
  const roots = [];
  for (const state of [stateDir('project', projectRoot), stateDir('user', projectRoot)]) {
    const dir = join(state, 'payload');
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      const root = join(dir, name, 'adapters');
      if (existsSync(root)) roots.push({ root, version: name, source: 'installed' });
    }
  }
  return roots;
}

export async function listAdapters({ ctx, options }) {
  const rows = new Map();
  const add = (root, meta) => {
    for (const dir of adapterDirs(root)) {
      const adapter = readDeclaration(join(dir, 'adapter.json'));
      if (adapter === null || typeof adapter.id !== 'string') continue;
      if (rows.has(adapter.id)) continue;
      rows.set(adapter.id, toRow(adapter, { ...meta, projectRoot: ctx.projectRoot }));
    }
  };

  if (options.from || process.env.R2C_PLUGIN_SOURCE) {
    const resolved = await resolvePayload({
      from: options.from ?? null,
      pluginVersion: options.plugin ?? null,
      projectRoot: ctx.projectRoot,
      engineVersion: ctx.version,
    });
    try {
      for (const entry of resolved.entries) {
        if (!/^adapters\/[^/]+\/adapter\.json$/.test(entry.rel)) continue;
        const adapter = readDeclaration(entry.abs);
        if (adapter === null || typeof adapter.id !== 'string' || rows.has(adapter.id)) continue;
        rows.set(
          adapter.id,
          toRow(adapter, {
            version: resolved.manifest.version,
            source: resolved.source,
            projectRoot: ctx.projectRoot,
          }),
        );
      }
    } finally {
      if (typeof resolved.cleanup === 'function') resolved.cleanup();
    }
  } else {
    if (existsSync(REPO_ADAPTERS)) add(REPO_ADAPTERS, { version: ctx.version, source: 'checkout' });
    for (const payload of installedPayloadRoots(ctx.projectRoot)) add(payload.root, payload);
  }

  const adapters = [...rows.values()].sort((left, right) => left.id.localeCompare(right.id));
  if (adapters.length === 0) {
    throw new R2cError(
      'NO_ADAPTERS',
      'no adapter declarations found; pass --from <payload>',
      { searched: [REPO_ADAPTERS] },
      EXIT_CODES.USAGE,
    );
  }
  return { command: 'adapter.list', data: { adapters } };
}
