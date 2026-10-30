/**
 * Shared zero-model discovery probe for markdown-based adapters.
 *
 * Reads `adapters/<id>/map.json`, resolves every `copy`/`render`/`wrap-skill`/
 * `derive-agent` target plus `link-root` against the installed tree, and fails
 * when any mapped command, skill or derived agent is not discoverable.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

function walk(dir, files = []) {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    let isDirectory = entry.isDirectory();
    if (!isDirectory && entry.isSymbolicLink()) {
      try {
        isDirectory = statSync(full).isDirectory();
      } catch {
        isDirectory = false;
      }
    }
    if (isDirectory) walk(full, files);
    else if (entry.isFile() || entry.isSymbolicLink()) files.push(full);
  }
  return files;
}

function matches(rel, pattern) {
  const relParts = rel.split('/');
  const patternParts = pattern.split('/');
  const test = (relIndex, patternIndex) => {
    if (patternIndex === patternParts.length) return relIndex === relParts.length;
    const part = patternParts[patternIndex];
    if (part === '**') {
      if (test(relIndex, patternIndex + 1)) return true;
      return relIndex < relParts.length && test(relIndex + 1, patternIndex);
    }
    if (relIndex >= relParts.length) return false;
    const escaped = part.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^${escaped.replaceAll('*', '.*').replaceAll('?', '.')}$`).test(relParts[relIndex])
      && test(relIndex + 1, patternIndex + 1);
  };
  return test(0, 0);
}

/** Roles declared by the payload manifests, in stable order. */
function agentRoles(payloadRoot) {
  const roles = new Set();
  for (const file of walk(join(payloadRoot, 'workflows'))) {
    if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/^\s*agent:\s*['"]?([A-Za-z0-9._-]+)['"]?\s*$/gm)) {
      roles.add(match[1]);
    }
  }
  return [...roles].sort();
}

export function runDiscovery({ adapterDir, payloadRoot, root, scope }) {
  if (typeof root !== 'string' || root === '') {
    process.stdout.write(`${JSON.stringify({ ok: false, missing: ['project-root'] })}\n`);
    return 3;
  }

  const map = JSON.parse(readFileSync(join(adapterDir, 'map.json'), 'utf8'));
  const missing = [];
  const found = { commands: 0, skills: 0, links: 0, agents: 0 };
  const roles = agentRoles(payloadRoot);

  for (const entry of map.entries ?? []) {
    if (entry.scope !== undefined && entry.scope !== scope) continue;
    if (entry.action === 'merge-json') continue;
    const target = entry.to
      .replaceAll('{project}', root)
      .replaceAll('{user}', root);
    if (entry.action === 'link-root') {
      if (!existsSync(target)) missing.push(target);
      else found.links += 1;
      continue;
    }
    if (entry.action === 'derive-agent') {
      if (roles.length === 0) {
        missing.push('workflow agents');
        continue;
      }
      for (const role of roles) {
        const name = role.replace(/[^a-zA-Z0-9._-]+/g, '-');
        const rendered = target.replaceAll('{name}', name).replaceAll('{stem}', name);
        if (!existsSync(rendered)) missing.push(rendered);
        else found.agents += 1;
      }
      continue;
    }
    const sources = walk(payloadRoot).filter((file) => {
      const rel = file.slice(payloadRoot.length + 1).split('\\').join('/');
      return matches(rel, entry.from);
    });
    if (sources.length === 0) {
      missing.push(entry.from);
      continue;
    }
    for (const source of sources) {
      const stem = basename(source).replace(/\.[^.]+$/, '');
      const dir = basename(dirname(source));
      const rendered = target.replaceAll('{stem}', stem).replaceAll('{dir}', dir);
      if (!existsSync(rendered)) missing.push(rendered);
      else if (rendered.split(/[\\/]/).includes('commands')) found.commands += 1;
      else found.skills += 1;
    }
  }

  if (found.commands === 0) missing.push('commands/r2c-*');

  process.stdout.write(
    `${JSON.stringify({ ok: missing.length === 0, scope, root, found, missing: missing.slice(0, 20) })}\n`,
  );
  return missing.length === 0 ? 0 : 3;
}
