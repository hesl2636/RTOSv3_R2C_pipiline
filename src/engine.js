/**
 * Engine bundle contract.
 *
 * The engine is published as its own release asset so a project can run r2c
 * with no npm and no checkout: `bin/r2c.js`, `src/**`, `schema/**`,
 * `package.json`, the vendored `yaml` dependency and `LICENSE`. The container
 * is the deterministic ustar+gzip writer from `plugin.js`, and the file-set
 * collector and path rules are shared with the payload: only the directory
 * list, the root files, the label and the asset name differ.
 */
import { collectArchiveTree } from './plugin.js';

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

/**
 * Collect the engine file set from a repository checkout.
 *
 * Returns `{ files: [{rel, absolute}], problems[] }`; problems (missing,
 * symlinked or over-long paths) make the release build fail, so the archive
 * contract can only be broken by editing this module.
 */
export function collectEngine(root) {
  return collectArchiveTree({
    root,
    label: 'engine archive',
    dirs: [...ENGINE_DIRS, ENGINE_VENDOR_DIR].map((dir) => ({ from: dir, rel: dir })),
    rootFiles: ENGINE_ROOT_FILES,
  });
}
