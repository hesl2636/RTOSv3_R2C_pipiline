/**
 * dsh install steps: the pieces a declarative map cannot express.
 *
 * dsh has no project-local plugin store: a profile at `$DSH_HOME/profiles/<name>`
 * owns `package.json` (dependency + `dsh.profile.bundles`) and a user
 * `cordis.patch.yml`. The native command is
 * `dsh plugin --profile <name> add link:<payload>/adapters/dsh`; when dsh is
 * unavailable we perform the same two manifest edits ourselves. Every write is
 * captured in `undo`, which the installer persists in its pending marker and
 * replays if the subsequent smoke check fails.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

const PACKAGE_NAME = 'r2c-adapter-dsh';
const PATCH_HEADER = [
  '# Your patch layer for this dsh profile, applied after every bundle layer:',
  '# a top-level YAML array of loader patch entries.',
].join('\n');

function homeDir() {
  return process.env.R2C_HOME || process.env.HOME || process.env.USERPROFILE || homedir();
}

function dshHome() {
  const configured = process.env.DSH_HOME;
  return configured !== undefined && configured !== '' ? configured : join(homeDir(), '.dsh');
}

function whichDsh() {
  const configured = process.env.R2C_DSH_BIN;
  if (configured !== undefined && configured !== '') return configured;
  const extensions = process.platform === 'win32'
    ? ['', ...(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map((value) => value.toLowerCase())]
    : [''];
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (dir === '') continue;
    for (const extension of extensions) {
      const candidate = join(dir, `dsh${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function profileName(context) {
  const name = typeof context.profile === 'string' && context.profile !== '' ? context.profile : 'web';
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(`invalid dsh profile name: ${name}`);
  }
  return name;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function ensureFile(file, content, undo) {
  if (existsSync(file)) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  undo.created_files.push(file);
}

function capture(file, undo) {
  const value = existsSync(file) ? readFileSync(file, 'utf8') : null;
  undo.files.push({ path: file, content: value });
  return value;
}

function toLink(value) {
  return `link:${value.split('\\').join('/')}`;
}

function runDshPluginAdd(name, adapterDir) {
  const bin = whichDsh();
  if (bin === null) return { ok: false, reason: 'dsh-not-found' };
  const line = [bin, 'plugin', '--profile', name, 'add', `link:${adapterDir}`]
    .map((part) => (/\s/.test(part) ? `"${part}"` : part))
    .join(' ');
  const result = spawnSync(line, {
    shell: true,
    encoding: 'utf8',
    timeout: 180_000,
    windowsHide: true,
  });
  if (result.error) return { ok: false, reason: result.error.message };
  if (result.status !== 0) {
    return {
      ok: false,
      reason: (result.stderr || result.stdout || `exit ${result.status}`).trim().split(/\r?\n/).at(-1),
    };
  }
  return { ok: true, bin };
}

/** Merge the dependency + bundle into an existing (or newly created) manifest. */
function mergeManifest(file, adapterDir) {
  let manifest;
  if (existsSync(file)) {
    manifest = readJson(file);
  } else {
    manifest = {
      name: `dsh-profile-${file.split(/[\\/]/).slice(-2, -1)[0]}`,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [] } },
    };
  }
  manifest.dependencies = manifest.dependencies ?? {};
  manifest.dependencies[PACKAGE_NAME] = toLink(adapterDir);
  manifest.dsh = manifest.dsh ?? {};
  manifest.dsh.profile = manifest.dsh.profile ?? {};
  const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : [];
  if (!bundles.includes(PACKAGE_NAME)) bundles.push(PACKAGE_NAME);
  manifest.dsh.profile.bundles = bundles;
  writeJson(file, manifest);
  return manifest;
}

function mcpRows(mcpPath) {
  const document = readJson(mcpPath);
  const servers = document?.mcpServers;
  if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) return [];
  return Object.entries(servers).map(([name, server]) => {
    const config = { serverName: name };
    if (typeof server?.url === 'string') {
      config.transport = 'streamable-http';
      config.url = server.url;
      if (server.headers !== undefined) config.headers = server.headers;
    } else {
      config.transport = 'stdio';
      if (typeof server?.command === 'string') config.command = server.command;
      if (Array.isArray(server?.args)) config.args = server.args;
      if (server?.env !== undefined) config.env = server.env;
      if (typeof server?.cwd === 'string') config.cwd = server.cwd;
    }
    return {
      id: `r2c-mcp-${name.replace(/[^A-Za-z0-9_-]/g, '-')}`,
      text: `- id: r2c-mcp-${name.replace(/[^A-Za-z0-9_-]/g, '-')}\n  name: '@deepseek-ai/dsh-mcp-client'\n  config: ${JSON.stringify(config)}\n`,
    };
  });
}

function appendPatchRows(file, rows) {
  if (rows.length === 0) return;
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  let body = current.trim();
  if (body === '' || body === '[]') body = PATCH_HEADER;
  const next = `${body.trimEnd()}\n\n${rows.map((row) => row.text).join('\n')}`;
  writeFileSync(file, next.endsWith('\n') ? next : `${next}\n`);
}

function nodeModulesLeftover(profileDir) {
  const modules = join(profileDir, 'node_modules');
  return existsSync(modules) ? [`node_modules:${modules}`] : [];
}

export async function postInstall(context) {
  const name = profileName(context);
  const profileDir = join(dshHome(), 'profiles', name);
  const adapterDir = join(context.payloadHome, 'adapters', 'dsh');
  const packageFile = join(profileDir, 'package.json');
  const patchFile = join(profileDir, 'cordis.patch.yml');
  const workspaceFile = join(profileDir, 'pnpm-workspace.yaml');
  const undo = context.undo ?? { profile: { dir: profileDir, name }, files: [], created_files: [], mcp_ids: [] };
  undo.profile = { dir: profileDir, name };
  undo.files = Array.isArray(undo.files) ? undo.files : [];
  undo.created_files = Array.isArray(undo.created_files) ? undo.created_files : [];
  undo.mcp_ids = Array.isArray(undo.mcp_ids) ? undo.mcp_ids : [];
  const warnings = [];

  mkdirSync(profileDir, { recursive: true });
  capture(packageFile, undo);
  capture(patchFile, undo);
  capture(workspaceFile, undo);
  ensureFile(patchFile, `${PATCH_HEADER}\n[]\n`, undo);
  ensureFile(
    workspaceFile,
    `packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n`,
    undo,
  );

  let mode = 'manual';
  let dshBin = null;
  const added = runDshPluginAdd(name, adapterDir);
  if (added.ok) {
    mode = 'dsh-plugin';
    dshBin = added.bin;
  } else if (added.reason !== 'dsh-not-found') {
    warnings.push(`dsh-plugin-add-failed:${added.reason}`);
  }

  // Verify the native command actually wrote both fields; a warning-only dsh
  // failure must never leave an installed plugin off the bundle list.
  let manifest = null;
  try {
    manifest = existsSync(packageFile) ? readJson(packageFile) : null;
  } catch (error) {
    warnings.push(`profile-manifest-invalid:${error.message}`);
  }
  const dependency = manifest?.dependencies?.[PACKAGE_NAME];
  const bundles = manifest?.dsh?.profile?.bundles;
  if (typeof dependency !== 'string' || !Array.isArray(bundles) || !bundles.includes(PACKAGE_NAME)) {
    manifest = mergeManifest(packageFile, adapterDir);
    if (mode === 'dsh-plugin') mode = 'dsh-plugin+manual-merge';
  }
  const recordedDependency = manifest?.dependencies?.[PACKAGE_NAME] ?? dependency ?? null;

  if (typeof context.mcp === 'string' && context.mcp !== '') {
    const rows = mcpRows(context.mcp);
    const bundlePatch = join(adapterDir, 'cordis.patch.yml');
    capture(bundlePatch, undo);
    appendPatchRows(bundlePatch, rows);
    undo.mcp_ids = rows.map((row) => row.id);
  }

  return {
    warnings,
    leftover: nodeModulesLeftover(profileDir),
    receipt: {
      profile: {
        name,
        dir: profileDir,
        package: packageFile,
        patch: patchFile,
        dependency: recordedDependency,
        bundle: PACKAGE_NAME,
      },
      bundle_patch: join(adapterDir, 'cordis.patch.yml'),
      mode,
      dsh: dshBin,
      mcp: undo.mcp_ids,
    },
    undo,
  };
}

export async function preUninstall(context) {
  const profile = context.receipt?.steps?.profile ?? null;
  if (profile === null || typeof profile.dir !== 'string') {
    return { warnings: ['profile-record-missing'], leftover: [] };
  }
  const warnings = [];
  const packageFile = join(profile.dir, 'package.json');
  if (existsSync(packageFile)) {
    try {
      const manifest = readJson(packageFile);
      if (manifest.dependencies !== undefined) delete manifest.dependencies[PACKAGE_NAME];
      const bundles = manifest?.dsh?.profile?.bundles;
      if (Array.isArray(bundles)) {
        manifest.dsh.profile.bundles = bundles.filter((bundle) => bundle !== PACKAGE_NAME);
      }
      writeJson(packageFile, manifest);
    } catch (error) {
      warnings.push(`profile-manifest-unreadable:${error.message}`);
    }
  } else {
    warnings.push(`profile-manifest-missing:${packageFile}`);
  }
  const patchFile = join(profile.dir, 'cordis.patch.yml');
  if (!existsSync(patchFile)) warnings.push(`profile-patch-missing:${patchFile}`);
  return { warnings, leftover: nodeModulesLeftover(profile.dir) };
}

/**
 * Replay the install's captured writes. The installer calls this when smoke
 * fails or when a pending marker from a crashed install is recovered.
 */
export async function rollback(context) {
  const undo = context.undo ?? {};
  for (const file of [...(undo.files ?? [])].reverse()) {
    try {
      if (file.content === null) {
        if (existsSync(file.path)) unlinkSync(file.path);
      } else {
        writeFileSync(file.path, file.content);
      }
    } catch {
      // best effort: the installer's own rollback reports failures
    }
  }
  for (const file of [...(undo.created_files ?? [])].reverse()) {
    try {
      if (existsSync(file)) unlinkSync(file);
    } catch {
      // best effort
    }
  }
  return {};
}

/** Exported for tests: the plugin owns the profile convention, not the loader. */
export const internals = { dshHome, profileName, mcpRows };
