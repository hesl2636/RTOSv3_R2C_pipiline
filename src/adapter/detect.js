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
import { existsSync, statSync } from 'node:fs';
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
