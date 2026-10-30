#!/usr/bin/env node
/**
 * Zero-model discovery probe for the omp adapter.
 *
 * Usage: node smoke.mjs <project-or-home-root> [--scope project|user] [--payload <home>]
 *
 * Two layers, both model-free:
 *   1. Every mapped `r2c-*` command, skill, derived agent, hook carrier and
 *      `mcp.json` target exists, is non-empty, and carries the metadata omp
 *      needs (skill `name` + `description`, agent `name` + `description`).
 *   2. When an `omp` binary is on PATH, `omp skill list --json` must list every
 *      installed skill with a non-empty description. Missing binary is not a
 *      failure; a listing that omits one of our skills is.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
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

function frontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (match === null) return {};
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    fields[line.slice(0, separator).trim()] = value;
  }
  return fields;
}

function skillExpectedNames() {
  const names = [];
  for (const entry of map.entries ?? []) {
    if (entry.action !== 'copy' || entry.from !== 'skills/*/SKILL.md') continue;
    const sources = walk(payloadRoot).filter((file) => {
      const rel = file.slice(payloadRoot.length + 1).split('\\').join('/');
      return matches(rel, entry.from);
    });
    for (const source of sources) {
      const fields = frontmatter(readFileSync(source, 'utf8'));
      names.push(fields.name || basename(dirname(source)));
    }
  }
  return [...new Set(names)].sort();
}

function workflowRoles() {
  const roles = new Set();
  for (const file of walk(payloadRoot)) {
    const rel = file.slice(payloadRoot.length + 1).split('\\').join('/');
    if (!/^workflows\/[^/]+\.yaml$/.test(rel)) continue;
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const match of text.matchAll(/^\s*agent:\s*['"]?([^'"\r\n#]+?)['"]?\s*(?:#.*)?$/gm)) {
      const role = match[1].trim();
      if (role !== '') roles.add(role);
    }
  }
  return [...roles].sort();
}

function findOnPath(name) {
  const extensions = process.platform === 'win32'
    ? ['', ...(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map((value) => value.toLowerCase())]
    : [''];
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (dir === '') continue;
    const clean = dir.replace(/^"|"$/g, '');
    for (const extension of extensions) {
      const candidate = join(clean, `${name}${extension}`);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

function ompProbe(expected) {
  const bin = findOnPath('omp');
  if (bin === null) return { status: 'unavailable', missing: [] };
  const isShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
  const command = isShell
    ? [bin, 'skill', 'list', '--json'].map((part) => `"${part}"`).join(' ')
    : bin;
  const result = spawnSync(command, isShell ? [] : ['skill', 'list', '--json'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
    shell: isShell,
    windowsHide: true,
  });
  if (result.error) {
    return { status: 'unavailable', detail: result.error.message, missing: [] };
  }
  if (result.status !== 0) {
    return {
      status: 'failed',
      missing: [`omp-skill-list-exit:${result.status}`],
      detail: (result.stderr || '').trim().split(/\r?\n/).slice(-3).join(' | '),
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    return { status: 'failed', missing: ['omp-skill-list-json'], detail: 'stdout is not JSON' };
  }
  const listed = new Map();
  for (const skill of parsed?.skills ?? []) {
    if (typeof skill?.name === 'string') listed.set(skill.name, skill);
  }
  const missing = [];
  for (const name of expected) {
    const skill = listed.get(name);
    if (skill === undefined) {
      missing.push(`skill-not-listed:${name}`);
    } else if (typeof skill.description !== 'string' || skill.description.trim() === '') {
      missing.push(`skill-no-description:${name}`);
    }
  }
  return { status: 'pass', missing };
}

const missing = [];
const found = { commands: 0, skills: 0, agents: 0, hooks: 0, mcp: 0 };
const expectedSkills = [];

for (const entry of map.entries ?? []) {
  if (entry.scope !== undefined && entry.scope !== scope) continue;
  const target = entry.to.replaceAll('{project}', root).replaceAll('{user}', root);

  if (entry.action === 'merge-json') {
    if (!existsSync(target)) {
      missing.push(target);
      continue;
    }
    try {
      JSON.parse(readFileSync(target, 'utf8'));
      found.mcp += 1;
    } catch {
      missing.push(`invalid-json:${target}`);
    }
    continue;
  }

  if (entry.action === 'derive-agent') {
    const roles = workflowRoles();
    if (roles.length === 0) {
      const dir = dirname(target);
      const files = existsSync(dir)
        ? readdirSync(dir).filter((name) => /^r2c-.*\.md$/.test(name))
        : [];
      if (files.length === 0) missing.push(`${dir}/r2c-*.md`);
      else found.agents += files.length;
      continue;
    }
    for (const role of roles) {
      const name = role.replace(/[^a-zA-Z0-9._-]+/g, '-');
      const rendered = target.replaceAll('{name}', name).replaceAll('{stem}', name);
      if (!existsSync(rendered)) {
        missing.push(rendered);
        continue;
      }
      const text = readFileSync(rendered, 'utf8');
      const fields = frontmatter(text);
      if (text.trim() === '' || !fields.name || !fields.description) {
        missing.push(`agent-metadata:${rendered}`);
      } else {
        found.agents += 1;
      }
    }
    continue;
  }

  if (entry.action === 'link-root') {
    if (!existsSync(target)) missing.push(target);
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
    if (!existsSync(rendered)) {
      missing.push(rendered);
      continue;
    }
    const text = readFileSync(rendered, 'utf8');
    if (text.trim() === '') {
      missing.push(`empty:${rendered}`);
      continue;
    }
    if (entry.to.includes('/commands/')) {
      found.commands += 1;
      continue;
    }
    if (entry.to.includes('/skills/')) {
      const fields = frontmatter(text);
      if (!fields.description) {
        missing.push(`skill-no-description:${rendered}`);
      } else {
        expectedSkills.push(fields.name || dir);
        found.skills += 1;
      }
      continue;
    }
    if (entry.to.includes('/hooks/')) {
      if (text.includes('process.execPath') || !text.includes('process.env.PATH')) {
        missing.push(`hook-node-resolution:${rendered}`);
      } else {
        found.hooks += 1;
      }
    }
  }
}

if (found.commands === 0) missing.push('commands/r2c-*');
if (found.skills === 0) missing.push('skills/*/SKILL.md');

const expected = skillExpectedNames();
const probe = ompProbe(expected);
missing.push(...probe.missing);

process.stdout.write(
  `${JSON.stringify({
    ok: missing.length === 0,
    scope,
    root,
    found,
    omp: probe.status,
    ...(probe.detail ? { omp_detail: probe.detail } : {}),
    missing: missing.slice(0, 30),
  })}\n`,
);
process.exit(missing.length === 0 ? 0 : 3);
