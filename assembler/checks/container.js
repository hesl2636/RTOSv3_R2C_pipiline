/**
 * Container checks that need the decoded archive (`checks/container.js`).
 *
 * The zip structure itself is decided by `assembler/zip.js` before inflation;
 * this module applies the bundle's exhaustive path whitelist, detects the
 * common "single outer directory" packaging mistake, and performs strict text
 * checks (BOM / UTF-8 / CR / trailing LF / lone surrogates).
 */
import { hasLoneSurrogate, isPlainObject } from '../util.js';
import {
  ASSET_KINDS,
  HOOKS_PATH,
  MCP_PATH,
  isAssetArea,
  probeAssetLayout,
} from './assets.js';

const decoder = new TextDecoder('utf-8', { fatal: true });

const ASSET_KIND_SET = new Set(ASSET_KINDS);
const STAGE_FILE = /^stages\/([a-z0-9]+(?:-[a-z0-9]+)*)\.json$/;
const ROLE_FILE = /^roles\/([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;
const TASK_FILE = /^tasks\/([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;
const SKILL_FILE = /^skills\/([a-z0-9]+(?:-[a-z0-9]+)*)\/SKILL\.md$/;
const SKILL_DIR = /^skills\/([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const KNOWLEDGE_BASE_FILE = /^knowledge-base\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.md$/;
const CHECKLIST_FILE = /^checklists\/([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;

/**
 * Classify a file path against the exhaustive whitelist (decision #67 §7.11).
 * `decode` marks files whose text participates in content checks. Asset paths
 * are classified by shape only; `check` admits them when the manifest declares
 * them.
 */
export function classifyFile(path) {
  if (path === 'bundle.json') return { kind: 'manifest', decode: true };
  if (path === 'README.md') return { kind: 'readme', decode: false };
  if (STAGE_FILE.test(path)) return { kind: 'stage', id: STAGE_FILE.exec(path)[1], decode: true };
  if (ROLE_FILE.test(path)) return { kind: 'role', id: ROLE_FILE.exec(path)[1], decode: true };
  if (TASK_FILE.test(path)) return { kind: 'task', id: TASK_FILE.exec(path)[1], decode: true };
  if (SKILL_FILE.test(path)) return { kind: 'skill', id: SKILL_FILE.exec(path)[1], decode: true };
  // A declared skill directory may only hold SKILL.md. Any other entry under
  // `skills/<id>/` falls through the whitelist and is BUNDLE_UNEXPECTED_PATH
  // (decision #67 §7.7, ticket #88).
  if (path === 'constitution/CONSTITUTION.md') return { kind: 'constitution', decode: true };
  if (path === MCP_PATH) return { kind: 'mcp', decode: true };
  if (path === HOOKS_PATH) return { kind: 'hooks', decode: true };
  if (KNOWLEDGE_BASE_FILE.test(path)) return { kind: 'knowledge-base', decode: true };
  if (CHECKLIST_FILE.test(path)) return { kind: 'checklist', id: CHECKLIST_FILE.exec(path)[1], decode: true };
  return null;
}

/**
 * Directory entries are optional, but no other directory may appear. A
 * constitution directory without a manifest item is owned by
 * BUNDLE_CONSTITUTION_UNDECLARED (decision #67 §7.8), not the container.
 */
export function classifyDirectory(path) {
  if (['stages', 'roles', 'tasks', 'skills', 'constitution'].includes(path)) return { kind: 'root' };
  if (SKILL_DIR.test(path)) return { kind: 'skill', id: SKILL_DIR.exec(path)[1] };
  return null;
}

function outerDirectory(names) {
  const present = names.filter((name) => name !== '');
  if (present.length === 0) return null;
  if (present.some((name) => !name.includes('/'))) return null;
  const top = present[0].split('/')[0];
  return present.every((name) => name.split('/')[0] === top) ? top : null;
}

function jsonHasLoneSurrogate(root) {
  const stack = [root];
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value === 'string') {
      if (hasLoneSurrogate(value)) return true;
    } else if (Array.isArray(value)) {
      for (const item of value) stack.push(item);
    } else if (isPlainObject(value)) {
      for (const key of Object.keys(value)) {
        if (hasLoneSurrogate(key)) return true;
        stack.push(value[key]);
      }
    }
  }
  return false;
}

function decodeText(context, entry) {
  const { path, data } = entry;
  const reject = (reason, message) => {
    context.undecodable.add(path);
    context.fail(path, 'BUNDLE_TEXT_ENCODING', message, { details: { reason } });
  };
  if (data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) {
    reject('bom', 'text file starts with a UTF-8 BOM');
    return;
  }
  let text;
  try {
    text = decoder.decode(data);
  } catch {
    reject('utf8', 'text file is not valid UTF-8');
    return;
  }
  if (text.includes('\r')) {
    reject('cr', 'text file contains a carriage return');
    return;
  }
  if (path.endsWith('.json') && text !== '') {
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      value = undefined;
    }
    if (value !== undefined && jsonHasLoneSurrogate(value)) {
      reject('lone-surrogate', 'JSON value contains a lone surrogate');
      return;
    }
  }
  // JSON's trailing LF is owned by *_JSON_NOT_CANONICAL (decision #67 §9.5);
  // only Markdown text reports the encoding reason directly.
  if (text !== '' && !text.endsWith('\n') && !path.endsWith('.json')) {
    reject('missing-final-lf', 'non-empty text file must end with a line feed');
    return;
  }
  context.texts.set(path, text);
}

export function check(context) {
  const names = [
    ...context.filePaths,
    ...context.directories.map((directory) => directory.name),
    ...context.rejected.map((item) => item.path),
  ];
  const hasManifest = context.filePaths.includes('bundle.json');
  if (!hasManifest && !context.rejectedPaths.has('bundle.json')) {
    const outer = outerDirectory(names);
    if (outer !== null) {
      context.fail('', 'BUNDLE_OUTER_DIRECTORY', 'archive has a single outer directory', {
        details: { entry: outer },
      });
      context.skipContent();
      return;
    }
  }
  if (context.rejectedPaths.has('bundle.json')) {
    // S4: the root manifest was rejected by the container; declarations are
    // unavailable, so content areas cannot run and must not cascade.
    context.skipContent();
  }

  // Asset admission depends on the manifest declarations, so the manifest is
  // decoded first. It stays unconditional: one failure is reported once.
  const layout = probeLayout(context);
  const unexpectedFile = (path, classified) => {
    if (classified !== null && !ASSET_KIND_SET.has(classified.kind)) return false;
    if (layout.files.has(path)) return false;
    // A declaration the manifest module already rejected owns the diagnosis;
    // reporting every asset-shaped path again would only be noise.
    return !(layout.known === false && isAssetArea(path));
  };
  const unexpectedDirectory = (path) => !layout.directories.has(path)
    && !(layout.known === false && isAssetArea(path));

  for (const path of context.filePaths) {
    if (unexpectedFile(path, classifyFile(path))) {
      context.unexpectedPaths.add(path);
      context.fail(path, 'BUNDLE_UNEXPECTED_PATH', 'file is not part of the bundle layout', {
        details: { entry: path },
      });
    }
  }
  for (const directory of context.directories) {
    if (classifyDirectory(directory.path) === null && unexpectedDirectory(directory.path)) {
      context.unexpectedPaths.add(directory.name);
      context.fail(directory.name, 'BUNDLE_UNEXPECTED_PATH', 'directory is not part of the bundle layout', {
        details: { entry: directory.name },
      });
    }
  }
  for (const entry of context.entries.values()) {
    if (entry.path === 'bundle.json') continue;
    const classified = classifyFile(entry.path);
    if (classified?.decode === true) decodeText(context, entry);
  }
}

/**
 * Decode `bundle.json` ahead of the whitelist and read its asset declarations.
 * Unreadable or undecodable manifests yield `known: false`.
 */
function probeLayout(context) {
  const entry = context.entries.get('bundle.json');
  if (entry === undefined) return probeAssetLayout(undefined);
  decodeText(context, entry);
  return probeAssetLayout(context.texts.get('bundle.json'));
}
