#!/usr/bin/env node
/**
 * Zero-model discovery probe for the codex adapter.
 *
 * Usage: node smoke.mjs <project-root> [--scope project] [--payload <root>]
 *
 * Codex discovers project commands as `.agents/skills/r2c-<id>/SKILL.md`
 * (frontmatter name/description required), skills in the same root and stage
 * agents in `.codex/agents/*.toml`. Hooks are checked as a carrier file only;
 * whether codex trusts them is a manual `/hooks` step, never a smoke failure.
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
if (scope !== 'project') {
  process.stdout.write(`${JSON.stringify({ ok: false, missing: [`scope:${scope}`] })}\n`);
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

function frontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (match === null) return null;
  const values = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return values;
}

function skillProblem(file, expectedName) {
  if (!existsSync(file)) return `missing:${file}`;
  const text = readFileSync(file, 'utf8');
  if (text.trim() === '') return `empty:${file}`;
  const attributes = frontmatter(text);
  if (attributes === null) return `no-frontmatter:${file}`;
  if (typeof attributes.name !== 'string' || attributes.name === '') return `no-name:${file}`;
  if (expectedName !== undefined && attributes.name !== expectedName) {
    return `wrong-name:${file}:${attributes.name}`;
  }
  if (typeof attributes.description !== 'string' || attributes.description === '') {
    return `no-description:${file}`;
  }
  return null;
}

const missing = [];
const found = { commands: 0, skills: 0, agents: 0, hooks: 0 };

for (const entry of map.entries ?? []) {
  if (entry.scope !== undefined && entry.scope !== scope) continue;
  if (entry.action === 'derive-agent') {
    const dir = join(root, '.codex', 'agents');
    const agents = existsSync(dir)
      ? readdirSync(dir).filter((name) => /^r2c-.*\.toml$/.test(name))
      : [];
    if (agents.length === 0) missing.push(dir);
    else {
      for (const name of agents) {
        const text = readFileSync(join(dir, name), 'utf8');
        if (!/^name\s*=\s*"r2c-/.test(text)) missing.push(`bad-agent:${join(dir, name)}`);
      }
      found.agents += agents.length;
    }
    continue;
  }
  if (!['copy', 'render', 'wrap-skill'].includes(entry.action)) continue;

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
    const target = entry.to
      .replaceAll('{project}', root)
      .replaceAll('{stem}', stem)
      .replaceAll('{dir}', dir);
    if (entry.action === 'render') {
      if (!existsSync(target)) missing.push(target);
      continue;
    }
    const problem = skillProblem(target, entry.action === 'wrap-skill' ? stem : undefined);
    if (problem !== null) {
      missing.push(problem);
      continue;
    }
    if (entry.action === 'wrap-skill') found.commands += 1;
    else found.skills += 1;
  }
}

if (found.commands === 0) missing.push('.agents/skills/r2c-*');

const hooksFile = join(root, '.codex', 'hooks.json');
if (!existsSync(hooksFile)) {
  missing.push(hooksFile);
} else {
  try {
    const document = JSON.parse(readFileSync(hooksFile, 'utf8'));
    for (const event of ['Stop', 'PreToolUse']) {
      if (!Array.isArray(document?.hooks?.[event]) || document.hooks[event].length === 0) {
        missing.push(`hooks.json:${event}`);
      }
    }
    found.hooks = 1;
  } catch {
    missing.push(`invalid:${hooksFile}`);
  }
}

process.stdout.write(
  `${JSON.stringify({ ok: missing.length === 0, scope, root, found, missing: missing.slice(0, 20) })}\n`,
);
process.exit(missing.length === 0 ? 0 : 3);
