/**
 * Zero-model discovery probe.
 *
 * `adapters/<agent>/smoke.mjs` performs the agent-independent part of "the
 * commands are discoverable": command/skill files exist at the mapped paths.
 * It never calls a model and never invokes the agent, so it is safe to run in
 * CI and after every install.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { userHome } from './util.js';

export function runAdapterSmoke({ payloadHome, agentId, scope, projectRoot }) {
  const script = join(payloadHome, 'adapters', agentId, 'smoke.mjs');
  if (!existsSync(script)) {
    return { available: false, ok: true, detail: 'smoke.mjs is not present in this payload' };
  }
  const root = scope === 'user' ? userHome() : projectRoot;
  const result = spawnSync(process.execPath, [script, root, '--scope', scope, '--payload', payloadHome], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
  });
  let parsed = null;
  try {
    parsed = result.stdout.trim() === '' ? null : JSON.parse(result.stdout.trim());
  } catch {
    parsed = null;
  }
  return {
    available: true,
    ok: result.status === 0,
    status: result.status,
    detail:
      parsed?.missing?.length > 0
        ? `missing: ${parsed.missing.slice(0, 8).join(', ')}`
        : (result.stderr || '').trim() || null,
    result: parsed,
  };
}
