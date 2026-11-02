/**
 * Legacy engine archive (P6 move, decision #77 §3.6).
 *
 * The engine is still published as `r2c-engine-<E>.tgz` with a frozen
 * extracted layout so installers and release bytes from before the move keep
 * working:
 *
 *   bin/r2c.js                         generated launcher
 *   runtime/r2c/engine/**              the engine package (bin/src/package.json)
 *   runtime/r2c/contract/**            the pure `r2c.workflow/v1` contract
 *   runtime/r2c/schema/**              state/workflow/latest/usage documents
 *   core/**                            the engine's only framework dependency
 *   package.json                       the same bytes as the engine package
 *   node_modules/yaml                  vendored so the extracted engine starts
 *   LICENSE
 *
 * The launcher is two lines because the archive keeps the engine at a
 * generic path: `bin/r2c.js` imports `../runtime/r2c/engine/bin/r2c.js`, and
 * both `package.json` copies point at their own real `bin/r2c.js`.
 */
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { compareCodePoints } from '../../core/code-point.js';

/** Entry point inside an extracted engine home. */
export const ENGINE_ENTRY = 'bin/r2c.js';
/** The same byte recipe as the legacy writer: paths at most 100 bytes. */
export const MAX_PATH_BYTES = 100;

export const ENGINE_LAUNCHER = `#!/usr/bin/env node
import '../runtime/r2c/engine/bin/r2c.js';
`;

/** Directories copied from the repository root into the archive. */
export const ENGINE_DIRS = Object.freeze([
  Object.freeze({ from: 'runtime/r2c/engine', rel: 'runtime/r2c/engine' }),
  Object.freeze({ from: 'runtime/r2c/contract', rel: 'runtime/r2c/contract' }),
  Object.freeze({ from: 'runtime/r2c/schema', rel: 'runtime/r2c/schema' }),
  Object.freeze({ from: 'core', rel: 'core' }),
  Object.freeze({ from: 'node_modules/yaml', rel: 'node_modules/yaml' }),
]);
/** Individual files copied from the repository root. */
export const ENGINE_ROOT_FILES = Object.freeze(['LICENSE']);
/** The engine package whose bytes also become the archive's root package.json. */
export const ENGINE_PACKAGE = 'runtime/r2c/engine/package.json';

/** The release asset name the packager writes and the bootstrap downloads. */
export function engineAssetName(version) {
  return `r2c-engine-${version}.tgz`;
}

function pathProblem(rel) {
  if (typeof rel !== 'string' || rel === '') return 'engine archive path is empty';
  const bytes = Buffer.byteLength(rel, 'utf8');
  if (bytes > MAX_PATH_BYTES) {
    return `engine archive path is ${bytes} bytes (max ${MAX_PATH_BYTES}): ${rel}`;
  }
  if (rel.startsWith('/') || rel.includes('\\')) {
    return `engine archive path must be relative and POSIX: ${rel}`;
  }
  if (rel.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return `engine archive path is not canonical: ${rel}`;
  }
  return null;
}

function walk(root, from, relDir, files, problems) {
  const absolute = join(root, from);
  if (!existsSync(absolute)) {
    problems.push(`missing engine archive path: ${from}`);
    return;
  }
  if (!statSync(absolute).isDirectory()) {
    problems.push(`engine archive path is not a directory: ${from}`);
    return;
  }
  const visit = (dir, rel) => {
    for (const name of readdirSync(dir).sort(compareCodePoints)) {
      const child = join(dir, name);
      const childRel = `${rel}/${name}`;
      const stat = lstatSync(child);
      if (stat.isSymbolicLink()) {
        problems.push(`symlink not allowed in engine archive: ${childRel}`);
      } else if (stat.isDirectory()) {
        visit(child, childRel);
      } else if (stat.isFile()) {
        const problem = pathProblem(childRel);
        if (problem !== null) problems.push(problem);
        else files.push({ rel: childRel, absolute: child });
      } else {
        problems.push(`unsupported file type in engine archive: ${childRel}`);
      }
    }
  };
  visit(absolute, relDir);
}

/**
 * Collect the engine archive file set from a repository checkout.
 *
 * Returns `{version, files: [{rel, absolute?, data?}], problems}`. Generated
 * entries carry `data`; copied entries carry `absolute`. Problems (missing,
 * symlinked or over-long paths) make the release build fail, so the archive
 * contract can only be broken by editing this module.
 */
export function collectEngine(root = process.cwd()) {
  const base = resolve(root);
  const files = [];
  const problems = [];

  for (const dir of ENGINE_DIRS) walk(base, dir.from, dir.rel, files, problems);
  for (const name of ENGINE_ROOT_FILES) {
    const absolute = join(base, name);
    if (!existsSync(absolute)) problems.push(`missing engine archive file: ${name}`);
    else files.push({ rel: name, absolute });
  }

  const packagePath = join(base, ENGINE_PACKAGE);
  if (!existsSync(packagePath)) {
    problems.push(`missing engine package: ${ENGINE_PACKAGE}`);
  }
  let version = null;
  if (existsSync(packagePath)) {
    try {
      version = JSON.parse(readFileSync(packagePath, 'utf8')).version ?? null;
    } catch (error) {
      problems.push(`cannot parse ${ENGINE_PACKAGE}: ${error.message}`);
    }
    files.push({ rel: 'package.json', absolute: packagePath });
    if (!files.some((file) => file.rel === ENGINE_PACKAGE)) {
      files.push({ rel: ENGINE_PACKAGE, absolute: packagePath });
    }
  }

  const launcher = pathProblem(ENGINE_ENTRY);
  if (launcher !== null) problems.push(launcher);
  else files.push({ rel: ENGINE_ENTRY, data: Buffer.from(ENGINE_LAUNCHER, 'utf8') });

  files.sort((left, right) => compareCodePoints(left.rel, right.rel));
  return { version, files, problems };
}

/** Archive bytes for one collected entry, whether copied or generated. */
export function engineEntryBytes(file) {
  return file.data ?? readFileSync(file.absolute);
}
