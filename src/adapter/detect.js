/**
 * Agent detection from `adapter.json.detect`.
 *
 * A probe is `commands` (`[bin, ...args]` whose stdout carries a semver) or
 * `paths` (an existing configuration directory). Any hit means the agent is
 * present; no hit is exit 4 at the command layer. Versions are best effort:
 * agents print very different banners, so we extract the first semver-looking
 * token and leave interpretation to `requires.agent`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve, sep } from 'node:path';
import { userHome } from './util.js';

const VERSION_RE = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/;

export function expandHome(value) {
  let expanded = value;
  if (expanded.startsWith('$')) {
    const match = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))([\\/].*)?$/.exec(expanded);
    if (match !== null) {
      const name = match[1] ?? match[2];
      const suffix = match[3] ?? '';
      const fromEnv = process.env[name];
      if (fromEnv === undefined || fromEnv === '') return null;
      expanded = `${fromEnv}${suffix}`;
    }
  }
  if (expanded === '~') return userHome();
  if (expanded.startsWith('~/') || expanded.startsWith('~\\')) return join(userHome(), expanded.slice(2));
  return expanded;
}

function pathExtensions() {
  if (process.platform !== 'win32') return [''];
  const fromEnv = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';');
  return ['', ...fromEnv.map((extension) => extension.toLowerCase())];
}

/** Resolve a bare binary name against PATH (with PATHEXT on Windows). */
export function which(bin) {
  const candidates = [];
  if (isAbsolute(bin) || bin.includes(sep)) {
    candidates.push(resolve(bin));
  } else {
    for (const dir of (process.env.PATH || '').split(delimiter)) {
      if (dir === '') continue;
      for (const extension of pathExtensions()) {
        candidates.push(join(dir, `${bin}${extension}`));
      }
    }
  }
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

function expandEnvVars(value) {
  let missing = false;
  const text = value.replace(/%([^%]+)%/g, (_, name) => {
    const replacement = process.env[name];
    if (replacement === undefined || replacement === '') {
      missing = true;
      return '';
    }
    return replacement;
  });
  return { text, missing };
}

/**
 * Expand a declarative binary glob such as
 * `%LOCALAPPDATA%/OpenAI/Codex/bin/*\/codex.exe`, newest file first.
 * Only `*` and `?` are supported; a missing environment variable means no hit.
 */
function globBinaries(pattern) {
  const expanded = expandEnvVars(pattern);
  if (expanded.missing) return [];
  const normalized = expanded.text.replaceAll('\\', '/');
  if (normalized === '' || normalized.includes('%')) return [];
  const drive = /^[A-Za-z]:\//.exec(normalized);
  const prefix = drive ? drive[0].slice(0, 2) : normalized.startsWith('/') ? '/' : '';
  const parts = normalized.slice(prefix.length).split('/').filter(Boolean);
  let candidates = [prefix];
  for (const part of parts) {
    const next = [];
    for (const current of candidates) {
      if (!part.includes('*') && !part.includes('?')) {
        next.push(current === '' ? part : current.endsWith('/') ? `${current}${part}` : `${current}/${part}`);
        continue;
      }
      let entries;
      try {
        entries = readdirSync(current === '' ? '.' : current);
      } catch {
        continue;
      }
      const escaped = part.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(
        `^${escaped.replaceAll('*', '.*').replaceAll('?', '.')}$`,
        process.platform === 'win32' ? 'i' : '',
      );
      for (const entry of entries) {
        if (!regex.test(entry)) continue;
        next.push(current === '' ? entry : current.endsWith('/') ? `${current}${entry}` : `${current}/${entry}`);
      }
    }
    candidates = next;
    if (candidates.length === 0) break;
  }
  return candidates
    .filter((candidate) => {
      try {
        return statSync(candidate).isFile();
      } catch {
        return false;
      }
    })
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
}

function runCommand(bin, args) {
  const extension = bin.slice(bin.lastIndexOf('.')).toLowerCase();
  const needsShell = process.platform === 'win32' && ['.cmd', '.bat'].includes(extension);
  const commandLine = [bin, ...args].map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(' ');
  const result = spawnSync(needsShell ? commandLine : bin, needsShell ? [] : args, {
    encoding: 'utf8',
    timeout: 15_000,
    shell: needsShell,
    windowsHide: true,
  });
  if (result.error) return { ok: false, error: result.error.message };
  if (result.status !== 0) {
    return { ok: false, error: `exited with ${result.status}`, stderr: (result.stderr || '').trim() };
  }
  const match = VERSION_RE.exec(`${result.stdout || ''}\n${result.stderr || ''}`);
  return { ok: true, version: match === null ? null : match[1] };
}

/**
 * Returns `{detected, bin, version, probes[], paths[]}`. `bin`/`version` come
 * from the first command probe that succeeded.
 */
export function detectAgent(detect = {}) {
  const probes = [];
  const paths = [];
  let bin = null;
  let version = null;

  for (const command of detect.commands ?? []) {
    if (!Array.isArray(command) || command.length === 0) continue;
    const [name, ...args] = command;
    const resolved = which(name);
    if (resolved === null) {
      probes.push({ kind: 'command', command: [name, ...args], ok: false, error: 'not found on PATH' });
      continue;
    }
    const outcome = runCommand(resolved, args);
    probes.push({ kind: 'command', command: [name, ...args], bin: resolved, ...outcome });
    if (outcome.ok && bin === null) {
      bin = resolved;
      version = outcome.version;
    }
  }

  const versionArgs = Array.isArray(detect.versionArgs) ? detect.versionArgs : ['--version'];
  for (const name of detect.envBins ?? []) {
    const declared = process.env[name];
    if (declared === undefined || declared === '') {
      probes.push({ kind: 'env', name, ok: false, error: 'not set' });
      continue;
    }
    const resolved = which(expandHome(declared));
    if (resolved === null) {
      probes.push({ kind: 'env', name, path: declared, ok: false, error: 'file not found' });
      continue;
    }
    const outcome = runCommand(resolved, versionArgs);
    probes.push({ kind: 'env', name, bin: resolved, ...outcome });
    if (bin === null) {
      bin = resolved;
      version = outcome.ok ? outcome.version : null;
    }
  }

  for (const pattern of detect.globBins ?? []) {
    const matches = globBinaries(pattern);
    if (matches.length === 0) {
      probes.push({ kind: 'glob', pattern, ok: false, error: 'no match' });
      continue;
    }
    for (const candidate of matches) {
      const outcome = runCommand(candidate, versionArgs);
      probes.push({ kind: 'glob', pattern, bin: candidate, ...outcome });
      if (bin === null) {
        bin = candidate;
        version = outcome.ok ? outcome.version : null;
      }
    }
  }

  for (const declared of detect.paths ?? []) {
    const expanded = expandHome(declared);
    if (expanded === null) {
      paths.push({ path: declared, present: false });
      continue;
    }
    let present = false;
    try {
      present = existsSync(expanded) && statSync(expanded).isDirectory();
    } catch {
      present = false;
    }
    paths.push({ path: expanded, present });
  }

  const detected = bin !== null || paths.some((entry) => entry.present);
  return { detected, bin, version, probes, paths };
}
