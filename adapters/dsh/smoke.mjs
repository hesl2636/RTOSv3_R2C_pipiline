#!/usr/bin/env node
/**
 * Zero-model discovery probe for the dsh adapter.
 *
 * Usage: node smoke.mjs <project-or-home-root> [--scope project|user]
 *        [--payload <payload-home>]
 *
 * A dsh install has two discovery surfaces: the rendered bundle inside the
 * payload (commands + `bundledSkillDir` patch) and the profile that must list
 * the bundle. No agent binary and no model call is involved.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const adapterDir = dirname(fileURLToPath(import.meta.url));
const payloadArg = process.argv.indexOf('--payload');
const payloadRoot = payloadArg === -1
  ? resolve(adapterDir, '..', '..')
  : resolve(process.argv[payloadArg + 1]);
const root = process.argv[2];

if (typeof root !== 'string' || root === '') {
  process.stdout.write(`${JSON.stringify({ ok: false, missing: ['project-root'] })}\n`);
  process.exit(3);
}

const missing = [];
const found = { commands: 0, skills: 0, bundle: false, patch: false, profile: null };

function requireFile(file, label) {
  if (existsSync(file) && statSync(file).isFile()) return readFileSync(file, 'utf8');
  missing.push(label ?? file);
  return null;
}

const bundleDir = join(payloadRoot, 'adapters', 'dsh');
const patch = requireFile(join(bundleDir, 'cordis.patch.yml'), 'adapters/dsh/cordis.patch.yml');
const plugin = requireFile(join(bundleDir, 'index.mjs'), 'adapters/dsh/index.mjs');
requireFile(join(bundleDir, 'package.json'), 'adapters/dsh/package.json');
requireFile(join(bundleDir, 'hooks.json'), 'adapters/dsh/hooks.json');

const commandsDir = join(payloadRoot, 'commands');
const commands = existsSync(commandsDir)
  ? readdirSync(commandsDir).filter((file) => /^r2c-[a-z0-9_-]+\.md$/i.test(file))
  : [];
found.commands = commands.length;
if (commands.length === 0) missing.push('commands/r2c-*.md');

const skillsDir = join(payloadRoot, 'skills');
const skills = existsSync(skillsDir)
  ? readdirSync(skillsDir).filter((name) => existsSync(join(skillsDir, name, 'SKILL.md')))
  : [];
found.skills = skills.length;
if (skills.length === 0) missing.push('skills/*/SKILL.md');

if (plugin !== null && !/(?:commands|registry)\s*\.\s*register\s*\(/.test(plugin)) {
  missing.push('index.mjs:ctx.commands.register');
}
if (patch !== null) {
  const hasPlugin = /adapters[\\/]dsh[\\/]index\.mjs/.test(patch);
  const hasSkills = /bundledSkillDir\s*:/.test(patch) && /skills/.test(patch);
  found.bundle = hasPlugin;
  found.patch = hasSkills;
  if (!hasPlugin) missing.push('cordis.patch.yml:r2c-dsh-plugin');
  if (!hasSkills) missing.push('cordis.patch.yml:bundledSkillDir');
}

// A profile is optional when the payload is inspected outside an install; when
// a DSH_HOME exists, its manifests must name the bundle.
const dshHome = process.env.DSH_HOME || join(process.env.R2C_HOME || process.env.HOME || process.env.USERPROFILE || '', '.dsh');
const profilesDir = join(dshHome, 'profiles');
if (existsSync(profilesDir)) {
  const candidates = readdirSync(profilesDir).filter((name) => existsSync(join(profilesDir, name, 'package.json')));
  for (const name of candidates) {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(profilesDir, name, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    const dependency = manifest?.dependencies?.['r2c-adapter-dsh'];
    const bundles = manifest?.dsh?.profile?.bundles ?? [];
    if (typeof dependency === 'string' && bundles.includes('r2c-adapter-dsh')) {
      found.profile = name;
      const profilePatch = join(profilesDir, name, 'cordis.patch.yml');
      if (!existsSync(profilePatch)) missing.push(`profile-patch:${profilePatch}`);
      break;
    }
  }
  if (found.profile === null) missing.push('profile:bundle r2c-adapter-dsh');
}

process.stdout.write(`${JSON.stringify({ ok: missing.length === 0, scope: 'user', root, found, missing: missing.slice(0, 20) })}\n`);
process.exit(missing.length === 0 ? 0 : 3);
