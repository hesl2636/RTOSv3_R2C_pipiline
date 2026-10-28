#!/usr/bin/env node
/**
 * Zero-model discovery probe for the opencode adapter.
 *
 * Usage: node smoke.mjs <project-or-home-root> [--scope project|user]
 *
 * Reads the sibling `map.json`, resolves every `copy`/`render`/`wrap-skill`
 * target (and link roots) against the installed project, and fails when a
 * mapped `r2c-*` command or a skill is not discoverable. `opencode run
 * --command r2c-status` is a live check and is intentionally not run here.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const adapterDir = dirname(fileURLToPath(import.meta.url));
const payloadArg = process.argv.indexOf('--payload');
const payloadRoot =
  payloadArg === -1 ? resolve(adapterDir, '..', '..') : resolve(process.argv[payloadArg + 1]);
const root = process.argv[2];
const scopeIndex = process.argv.indexOf('--scope');
const scope = scopeIndex === -1 ? 'project' : process.argv[scopeIndex + 1];

if (typeof root !== 'string' || root === '') {
  process.stdout.write(`${JSON.stringify({ ok: false, missing: ['project-root'] })}\n`);
  process.exit(3);
}

const map = JSON.parse(readFileSync(join(adapterDir, 'map.json'), 'utf8'));

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

const missing = [];
const found = { commands: 0, skills: 0, links: 0 };

for (const entry of map.entries ?? []) {
  if (entry.scope !== undefined && entry.scope !== scope) continue;
  if (entry.action === 'merge-json' || entry.action === 'derive-agent') continue;
  const target = entry.to
    .replaceAll('{project}', root)
    .replaceAll('{user}', root);
  if (entry.action === 'link-root') {
    if (!existsSync(target)) missing.push(target);
    else found.links += 1;
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
process.exit(missing.length === 0 ? 0 : 3);
