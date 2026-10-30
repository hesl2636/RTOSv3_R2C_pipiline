/**
 * Hook input normalisation and the write-guard surface.
 *
 * Every agent speaks a slightly different hook dialect. This module is the one
 * shim that turns an arbitrary stdin JSON value into the single contract the
 * command surface depends on:
 *
 *   { session_id, cwd, tool_name, tool_input }
 *
 * and extracts the files a tool call intends to write. Malformed input is
 * ignored: hooks must never turn a bad payload into a crashed session. Bash
 * command bodies are never parsed (a shell string is opaque), so a protected
 * path mentioned in a command is not a write attempt.
 */
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { discoverManifest } from './manifest.js';

/** Tool names whose `tool_input` is an opaque command/template body. */
const SHELL_TOOL = /bash|shell|powershell|pwsh|exec|command|terminal|(^|_)(sh|cmd|zsh)(_|$)/i;

const PATH_FIELDS = ['file_path', 'path', 'notebook_path', 'filePath', 'notebookPath'];
const PATCH_FIELDS = ['patch', 'input', 'content', 'diff'];
const PATCH_HEADER = /^[ \t]*\*\*\*[ \t]+(?:Add|Update|Delete)[ \t]+File:[ \t]*(.+?)[ \t]*$/gm;

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string') return value;
  }
  return null;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Normalise one hook payload. Accepts snake_case and camelCase aliases; an
 * absent or malformed payload normalises to four nulls instead of throwing.
 */
export function normalizeHookInput(value) {
  const input = {
    session_id: null,
    cwd: null,
    tool_name: null,
    tool_input: null,
  };
  try {
    if (!isPlainObject(value)) return input;
    input.session_id = firstString(value.session_id, value.sessionId, value.sessionID);
    input.cwd = firstString(value.cwd, value.working_dir, value.workingDir);
    input.tool_name = firstString(value.tool_name, value.toolName, value.tool);
    if ('tool_input' in value) input.tool_input = value.tool_input;
    else if ('toolInput' in value) input.tool_input = value.toolInput;
    else if ('toolArgs' in value) input.tool_input = value.toolArgs;
  } catch {
    // Arbitrary JSON must never throw out of the shim.
  }
  return input;
}

function pushPath(paths, value) {
  if (typeof value !== 'string' || value.trim() === '') return;
  paths.push(value);
}

function pushPatchHeaders(paths, text) {
  if (typeof text !== 'string' || text === '') return;
  for (const match of text.matchAll(PATCH_HEADER)) {
    const file = match[1]?.trim();
    if (file !== '') paths.push(file.replace(/^"(.*)"$/, '$1'));
  }
}

/**
 * Collect the target paths of a tool call. Recognised shapes:
 * - `file_path` / `path` / `notebook_path` on `tool_input`;
 * - `edits[].file_path`;
 * - `*** Add|Update|Delete File: <path>` patch headers in patch-like fields
 *   (or in a string `tool_input` for non-shell tools).
 */
export function extractTargetPaths(normalized) {
  const paths = [];
  const input = normalized?.tool_input;
  if (input === null || input === undefined) return paths;

  const shellTool = typeof normalized?.tool_name === 'string' && SHELL_TOOL.test(normalized.tool_name);

  if (typeof input === 'string') {
    if (!shellTool) pushPatchHeaders(paths, input);
    return paths;
  }

  if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === 'string') {
        if (!shellTool) pushPatchHeaders(paths, item);
      } else if (isPlainObject(item)) {
        for (const field of PATH_FIELDS) pushPath(paths, item[field]);
      }
    }
    return paths;
  }

  if (!isPlainObject(input)) return paths;

  for (const field of PATH_FIELDS) pushPath(paths, input[field]);

  if (Array.isArray(input.edits)) {
    for (const edit of input.edits) {
      if (!isPlainObject(edit)) continue;
      for (const field of PATH_FIELDS) pushPath(paths, edit[field]);
    }
  }

  if (!shellTool) {
    for (const field of PATCH_FIELDS) pushPatchHeaders(paths, input[field]);
  }

  return paths;
}

function comparable(file) {
  return process.platform === 'win32' ? file.toLowerCase() : file;
}

function partsOf(file) {
  return file.split(/[\\/]+/).filter((part) => part !== '' && part !== '.');
}

/**
 * Protected in-project surfaces (spec §4/I6, #6 comment 2):
 * `.r2c/runs/**`, `.r2c/usage/**`, `.r2c/latest.json`, `workflows/*.yaml`.
 * Business artefacts (`.r2c/ir.md`, `.r2c/sr-map.md`, `.r2c/artifacts/**`)
 * and everything else are writable.
 */
function isProtectedRelative(relativePath) {
  const parts = partsOf(relativePath);
  if (parts.length === 0) return false;
  const folded = parts.map((part) => comparable(part));
  if (folded[0] !== '.r2c') {
    return folded[0] === 'workflows' && folded.length === 2 && folded[1].endsWith('.yaml');
  }
  if (folded[1] === 'runs' || folded[1] === 'usage') return folded.length >= 2;
  return folded.length === 2 && folded[1] === 'latest.json';
}

/**
 * Resolve the manifest paths the runner itself would treat as workflows, so a
 * write to an explicitly selected manifest outside `workflows/` is guarded
 * too. Discovery failure is not a guard failure: it simply adds nothing.
 */
export function detectedManifestPaths({ projectRoot, manifest = null }) {
  const found = new Set();
  if (typeof manifest === 'string' && manifest !== '') {
    found.add(resolve(projectRoot, manifest));
  }
  try {
    const discovered = discoverManifest({ manifest, projectRoot });
    found.add(discovered.manifestPath);
  } catch {
    // No manifest, ambiguous manifests and parse errors are not guard hits.
  }
  return [...found];
}

/** Return the denied target path, or null when every target is writable. */
export function findProtectedTarget({ projectRoot, targetPaths, manifestPaths = [] }) {
  const root = resolve(projectRoot);
  const manifests = new Set(manifestPaths.map((file) => comparable(resolve(root, file))));
  for (const target of targetPaths) {
    if (typeof target !== 'string' || target.trim() === '') continue;
    const absolute = resolve(root, target);
    if (manifests.has(comparable(absolute))) return target;
    const rel = relative(root, absolute);
    if (rel === '' || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) continue;
    if (isProtectedRelative(rel)) return target;
  }
  return null;
}
