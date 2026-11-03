/**
 * Bundle asset checks (`knowledge-base/`, `checklists/`, `hooks/`, `mcp.json`).
 *
 * The manifest owns the declarations (`checks/manifest.js`); this module owns
 * the path grammar shared with the container whitelist, the presence checks for
 * declared files, and the canonical-JSON rules for the two JSON assets.
 *
 * Admission is declaration-driven: `probeAssetLayout` is the same reading the
 * container applies before the manifest phase, so an undeclared asset file is
 * one `BUNDLE_UNEXPECTED_PATH` instead of a cascade.
 */
import { MAX_PATH_BYTES, utf8Length } from '../../core/paths.js';
import {
  COMPILED_WORKFLOW_CHECKLIST_ROOT,
  COMPILED_WORKFLOW_HOOKS_PATH,
  COMPILED_WORKFLOW_KNOWLEDGE_BASE_ROOT,
  COMPILED_WORKFLOW_MCP_PATH,
  compiledWorkflowChecklistPath,
} from '../../compiled/schema.js';
import { LIMITS } from '../limits.js';
import { isPlainObject } from '../util.js';
import { readJsonDocument } from './json.js';

export const HOOKS_PATH = COMPILED_WORKFLOW_HOOKS_PATH;
export const MCP_PATH = COMPILED_WORKFLOW_MCP_PATH;
const KNOWLEDGE_BASE_ROOT = `${COMPILED_WORKFLOW_KNOWLEDGE_BASE_ROOT}/`;
const CHECKLIST_ROOT = `${COMPILED_WORKFLOW_CHECKLIST_ROOT}/`;
const HOOKS_ROOT = 'hooks/';

/** File classification kinds owned by this module. */
export const ASSET_KINDS = Object.freeze(['knowledge-base', 'checklist', 'hooks', 'mcp']);

const SEGMENT = '[A-Za-z0-9._-]+';
const KNOWLEDGE_BASE_RE = new RegExp(`^${COMPILED_WORKFLOW_KNOWLEDGE_BASE_ROOT}/(?:${SEGMENT}/)*${SEGMENT}\\.md$`);

/** Declared asset path -> `checklists/<id>.md`. */
export function checklistPath(id) {
  return compiledWorkflowChecklistPath(id);
}

/** True when `path` is a legal declared knowledge-base markdown path. */
export function isKnowledgeBasePath(path) {
  if (typeof path !== 'string' || !KNOWLEDGE_BASE_RE.test(path)) return false;
  return utf8Length(path) <= MAX_PATH_BYTES && path.split('/').length <= LIMITS.MAX_PATH_DEPTH;
}

/** True when `path` is inside an asset area the container admits on declaration. */
export function isAssetArea(path) {
  return path === MCP_PATH || path.startsWith(KNOWLEDGE_BASE_ROOT)
    || path.startsWith(CHECKLIST_ROOT) || path.startsWith(HOOKS_ROOT);
}

/** Every ancestor directory of the given file paths. */
export function assetDirectories(paths) {
  const directories = new Set();
  for (const path of paths) {
    const segments = path.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join('/'));
    }
  }
  return directories;
}

function declaredStringArray(manifest, key) {
  const value = manifest[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return null;
  return value;
}

function declaredFile(manifest, key) {
  const value = manifest[key];
  if (value === undefined) return { known: true, path: null };
  if (!isPlainObject(value) || typeof value.path !== 'string') return { known: false, path: null };
  // The declared path is admitted verbatim; `checks/manifest.js` owns its
  // validity, so a wrong constant cannot also raise BUNDLE_UNEXPECTED_PATH.
  return { known: true, path: value.path };
}

/**
 * Read the asset declarations from raw `bundle.json` text.
 *
 * `known: false` means a declaration is present but unreadable: the manifest
 * phase already reports the root cause, so the container stays silent about
 * every asset-shaped path rather than cascading.
 *
 * @param {string|undefined} text decoded manifest text
 * @returns {{ known: boolean, files: Set<string>, directories: Set<string> }}
 */
export function probeAssetLayout(text) {
  const layout = { known: false, files: new Set(), directories: new Set() };
  if (typeof text !== 'string') return layout;
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    return layout;
  }
  if (!isPlainObject(manifest)) return layout;
  const knowledgeBase = declaredStringArray(manifest, 'knowledgeBase');
  const checklists = declaredStringArray(manifest, 'checklists');
  const hooks = declaredFile(manifest, 'hooks');
  const mcp = declaredFile(manifest, 'mcp');
  if (knowledgeBase === null || checklists === null || !hooks.known || !mcp.known) return layout;

  const files = [...knowledgeBase, ...checklists.map(checklistPath)];
  if (hooks.path !== null) files.push(hooks.path);
  if (mcp.path !== null) files.push(mcp.path);
  for (const path of files) layout.files.add(path);
  for (const directory of assetDirectories(files)) layout.directories.add(directory);
  layout.known = true;
  return layout;
}

function missing(context, path) {
  context.fail(path, 'BUNDLE_ASSET_FILE_MISSING', 'declared asset is missing from the archive', {
    details: { path },
  });
}

/** True when the declared file is available for content checks. */
function present(context, path) {
  if (context.entries.has(path)) return true;
  if (!context.rejectedPaths.has(path)) missing(context, path);
  return false;
}

function checkJsonAsset(context, path, shape) {
  const text = context.texts.get(path);
  if (text === undefined) return;
  const document = readJsonDocument(context, path, text);
  if (document === null) return;
  if (shape !== undefined) shape(document.value);
}

export function check(context) {
  if (context.skipped.assets === true) return;
  const manifest = context.manifest;
  if (manifest === null || manifest === undefined) return;
  const declared = context.declared ?? {};
  const valid = context.declaredValid ?? {};

  if (valid.knowledgeBase !== false) {
    for (const path of declared.knowledgeBase ?? []) present(context, path);
  }
  if (valid.checklists !== false) {
    for (const id of declared.checklists ?? []) present(context, checklistPath(id));
  }

  const declaration = context.assetDeclaration ?? {};
  if (declaration.hooks?.declared === true && declaration.hooks.valid === true) {
    if (present(context, HOOKS_PATH)) checkJsonAsset(context, HOOKS_PATH);
  }
  if (declaration.mcp?.declared === true && declaration.mcp.valid === true
    && present(context, MCP_PATH)) {
    checkJsonAsset(context, MCP_PATH, (value) => {
      if (isPlainObject(value) && isPlainObject(value.mcpServers)) return;
      context.fail(MCP_PATH, 'BUNDLE_MCP_INVALID', "mcp.json must carry an object under 'mcpServers'", {
        pointer: isPlainObject(value) && value.mcpServers !== undefined ? '/mcpServers' : '',
        details: { rule: 'shape' },
      });
    });
  }
}
