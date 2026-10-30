/**
 * Engine bundle contract.
 *
 * The engine is published as its own release asset so a project can run r2c
 * with no npm and no checkout: `bin/r2c.js`, `src/**`, `schema/**`,
 * `package.json`, the vendored `yaml` dependency and `LICENSE`. The container
 * is the deterministic ustar+gzip writer from `plugin.js`; only the file set
 * and the asset name differ from the payload.
 */
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_PATH_BYTES, comparePayloadPaths } from './plugin.js';

/** Directories copied verbatim from the repository root. */
export const ENGINE_DIRS = Object.freeze(['bin', 'src', 'schema']);
/** The dependency vendored so the extracted engine starts without npm. */
export const ENGINE_VENDOR_DIR = 'node_modules/yaml';
/** Individual files copied from the repository root. */
export const ENGINE_ROOT_FILES = Object.freeze(['package.json', 'LICENSE']);
/** Entry point inside an extracted engine home. */
export const ENGINE_ENTRY = 'bin/r2c.js';

/** The release asset name the packager writes and the bootstrap downloads. */
export function engineAssetName(version) {
  return `r2c-engine-${version}.tgz`;
}

/** `null` when `rel` is a legal engine archive path, otherwise a problem string. */
function enginePathProblem(rel) {
  if (typeof rel !== 'string' || rel === '') return 'engine path is empty';
  const bytes = Buffer.byteLength(rel, 'utf8');
  if (bytes > MAX_PATH_BYTES) {
    return `engine path is ${bytes} bytes (max ${MAX_PATH_BYTES}): ${rel}`;
  }
  if (rel.startsWith('/') || rel.includes('\\')) {
    return `engine path must be relative and POSIX: ${rel}`;
  }
  const segments = rel.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return `engine path is not canonical: ${rel}`;
  }
  return null;
}

/**
 * Collect the engine file set from a repository checkout.
 *
 * Returns `{ files: [{rel, absolute}], problems[] }`; problems (missing,
 * symlinked or over-long paths) make the release build fail, so the archive
 * contract can only be broken by editing this module.
 */
export function collectEngine(root) {
  const files = [];
  const problems = [];

  const walk = (absolute, relDir) => {
    for (const name of readdirSync(absolute).sort(comparePayloadPaths)) {
      const child = join(absolute, name);
      const rel = `${relDir}/${name}`;
      const stat = lstatSync(child);
      if (stat.isSymbolicLink()) {
        problems.push(`symlink not allowed in the engine archive: ${rel}`);
        continue;
      }
      if (stat.isDirectory()) {
        walk(child, rel);
        continue;
      }
      if (!stat.isFile()) {
        problems.push(`unsupported file type in the engine archive: ${rel}`);
        continue;
      }
      const problem = enginePathProblem(rel);
      if (problem !== null) {
        problems.push(problem);
        continue;
      }
      files.push({ rel, absolute: child });
    }
  };

  const addTree = (absolute, relDir) => {
    if (!existsSync(absolute)) {
      problems.push(`missing engine path: ${relDir}`);
      return;
    }
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      problems.push(`symlink not allowed in the engine archive: ${relDir}`);
      return;
    }
    if (!stat.isDirectory()) {
      problems.push(`engine path is not a directory: ${relDir}`);
      return;
    }
    const before = files.length;
    walk(absolute, relDir);
    if (files.length === before) problems.push(`engine directory is empty: ${relDir}`);
  };

  for (const dir of ENGINE_DIRS) addTree(join(root, dir), dir);
  addTree(join(root, ENGINE_VENDOR_DIR), ENGINE_VENDOR_DIR);
  for (const name of ENGINE_ROOT_FILES) {
    const absolute = join(root, name);
    if (!existsSync(absolute)) {
      problems.push(`missing engine file: ${name}`);
      continue;
    }
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) problems.push(`symlink not allowed in the engine archive: ${name}`);
    else if (!stat.isFile()) problems.push(`engine file is not a regular file: ${name}`);
    else files.push({ rel: name, absolute });
  }

  files.sort((left, right) => comparePayloadPaths(left.rel, right.rel));
  const seen = new Set();
  for (const file of files) {
    if (seen.has(file.rel)) problems.push(`duplicate engine path: ${file.rel}`);
    seen.add(file.rel);
  }
  return { files, problems };
}
