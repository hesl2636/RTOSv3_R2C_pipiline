/**
 * Pre-projected payload contract (`hm2b.release-payload/v1`, #74 §3.4, #105).
 *
 * A Release payload is the validated projection result minus file contents:
 * `manifest.json` declares bundle/compiled workflow/projection/options/targets/file hashes,
 * and the archive carries exactly `files/<path>` members. The manifest also
 * records the projection result's non-file members (`result`), so an installer
 * can rebuild the exact object V1–V12 validated at release time and never has
 * to compile or project again (#106).
 *
 * Everything here is pure verification: reading bytes, hashing, comparing.
 */
import { jsonEqual as sameValue } from '../core/json.js';
import { isCanonicalJson } from '../core/canonical-json.js';
import { compareCodePoints } from '../core/code-point.js';
import { sha256Hex } from '../core/node/sha256.js';
import { foldCase, hasFileDirPrefixConflict } from '../core/paths.js';
import { isValidVersion } from '../core/semver.js';
import { RESULT_BLOCK_FIELDS, RESULT_FIELDS } from '../projection/result-fields.js';
import { readReleaseTarGz } from './release-tar.js';

export const RELEASE_PAYLOAD_SCHEMA = 'hm2b.release-payload/v1';
export const PAYLOAD_MANIFEST_NAME = 'manifest.json';

/**
 * File kinds a payload member may declare. Mirrors
 * `projection/schema/result.schema.json` `files[].kind`, including the v2 compiled workflow
 * assets (`knowledge`, `checklist`, `hooks`, `mcp`): a compiled workflow that carries asset
 * bodies projects them as payload members, so the installer must never refuse
 * a Release for shipping them.
 */
export const PAYLOAD_FILE_KINDS = Object.freeze([
  'workflow',
  'stage',
  'task',
  'role',
  'skill',
  'constitution',
  'knowledge',
  'checklist',
  'hooks',
  'mcp',
  'agent',
  'command',
  'rules',
  'metadata',
  'readme',
  'other',
]);
const PAYLOAD_FILE_KIND_SET = new Set(PAYLOAD_FILE_KINDS);

// The top-level member order is the projection-result contract; the manifest
// and the validator must agree, so both import `projection/result-fields.js`.
export { RESULT_BLOCK_FIELDS, RESULT_FIELDS };

/**
 * The manifest's `result` block: the projection result without file content,
 * in the canonical top-level order. `files[]` lives in `manifest.files`.
 */
export function payloadResultBlock(result) {
  const block = {};
  for (const field of RESULT_BLOCK_FIELDS) {
    if (field === 'installPlan') {
      block.installPlan = result.installPlan;
      continue;
    }
    block[field] = result[field];
  }
  return block;
}

/**
 * Split a payload archive into members + manifest. Returns
 * `{entries, manifest, problems}`; `entries` is a `Map<path, {data, mode}>`.
 */
export function readPayloadArchive(bytes) {
  const { entries, problems } = readReleaseTarGz(bytes);
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const manifestEntry = byPath.get(PAYLOAD_MANIFEST_NAME);
  if (manifestEntry === undefined) {
    return { entries: byPath, manifest: null, problems: [...problems, `${PAYLOAD_MANIFEST_NAME} is missing from the payload`] };
  }
  const text = Buffer.from(manifestEntry.data).toString('utf8');
  if (!isCanonicalJson(text)) problems.push(`${PAYLOAD_MANIFEST_NAME} is not canonical JSON`);
  let manifest = null;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    problems.push(`${PAYLOAD_MANIFEST_NAME} is not valid JSON: ${error.message}`);
  }
  return { entries: byPath, manifest, problems };
}

/**
 * Self-proof of one payload archive: member set == manifest set, member
 * hashes/modes == manifest, canonical manifest bytes, sorted paths, no
 * file/dir prefix conflicts, deterministic metadata.
 *
 * `expected` = `{id, version, compiledWorkflowDigest, contentSha256, projectionId, options,
 * targets}`; when it also carries `result`, the manifest's recorded result
 * block must equal it (build-time proof of the install-time contract).
 */
export function verifyPayloadArchive(bytes, expected) {
  const { entries, manifest, problems } = readPayloadArchive(bytes);
  const paths = [...entries.keys()];
  if (!sameValue(paths, [...paths].sort(compareCodePoints))) problems.push('payload members are not sorted by path');
  if (manifest === null) return problems;
  if (manifest?.schema !== RELEASE_PAYLOAD_SCHEMA) {
    problems.push(`${PAYLOAD_MANIFEST_NAME} schema is ${String(manifest?.schema)}`);
  }
  if (!sameValue(manifest?.bundle, { id: expected.id, version: expected.version })) {
    problems.push(`${PAYLOAD_MANIFEST_NAME} bundle ${JSON.stringify(manifest?.bundle)} does not match ${expected.id}@${expected.version}`);
  }
  if (manifest?.compiledWorkflow?.digest !== expected.compiledWorkflowDigest) {
    problems.push(`${PAYLOAD_MANIFEST_NAME} compiledWorkflow.digest does not match the compiled workflow bytes`);
  }
  if (manifest?.compiledWorkflow?.contentSha256 !== expected.contentSha256) {
    problems.push(`${PAYLOAD_MANIFEST_NAME} compiledWorkflow.contentSha256 does not match the compiled workflow source`);
  }
  if (manifest?.projection?.id !== expected.projectionId) {
    problems.push(`${PAYLOAD_MANIFEST_NAME} projection.id is ${String(manifest?.projection?.id)}`);
  }
  if (!isValidVersion(manifest?.projection?.version)) {
    problems.push(`${PAYLOAD_MANIFEST_NAME} projection.version is not a semver`);
  }
  if (!sameValue(manifest?.options, expected.options)) {
    problems.push(`${PAYLOAD_MANIFEST_NAME} options do not record the canonical input`);
  }
  if (!sameValue(manifest?.targets, expected.targets)) {
    problems.push(`${PAYLOAD_MANIFEST_NAME} targets do not match the projection`);
  }
  if (expected.result !== undefined) {
    const block = payloadResultBlock(expected.result);
    if (!sameValue(manifest?.result, block)) {
      problems.push(`${PAYLOAD_MANIFEST_NAME} result does not match the validated projection result`);
    }
  }

  const declared = Array.isArray(manifest?.files) ? manifest.files : [];
  const declaredPaths = declared.map((file) => file?.path);
  if (!sameValue(declaredPaths, [...declaredPaths].sort(compareCodePoints))) {
    problems.push(`${PAYLOAD_MANIFEST_NAME} files are not sorted by path`);
  }
  if (new Set(declaredPaths.map(foldCase)).size !== declaredPaths.length) {
    problems.push(`${PAYLOAD_MANIFEST_NAME} has duplicate paths`);
  }
  for (let index = 0; index < declaredPaths.length; index += 1) {
    for (let other = index + 1; other < declaredPaths.length; other += 1) {
      if (hasFileDirPrefixConflict(declaredPaths[index], declaredPaths[other])) {
        problems.push(`${PAYLOAD_MANIFEST_NAME} paths conflict: ${declaredPaths[index]} / ${declaredPaths[other]}`);
      }
    }
  }
  const expectedMembers = new Set(declaredPaths.map((path) => `files/${path}`));
  expectedMembers.add(PAYLOAD_MANIFEST_NAME);
  for (const [path, entry] of entries) {
    if (!expectedMembers.has(path)) problems.push(`payload member is not declared: ${path}`);
    if (entry.mtime !== 0 || entry.uid !== 0 || entry.gid !== 0) {
      problems.push(`payload member has non-zero metadata: ${path}`);
    }
  }
  if (entries.size !== expectedMembers.size) {
    problems.push(`payload member count ${entries.size} does not match the manifest (${expectedMembers.size})`);
  }
  const targets = new Set(manifest?.targets ?? []);
  const covered = new Set();
  for (const file of declared) {
    if (file === null || typeof file !== 'object') {
      problems.push(`${PAYLOAD_MANIFEST_NAME} has a non-object file entry`);
      continue;
    }
    if (file.mode !== 0o644 && file.mode !== 0o755) problems.push(`${file.path}: mode must be 0644 or 0755`);
    if (!Array.isArray(file.targets) || file.targets.length === 0) {
      problems.push(`${file.path}: targets must be a non-empty array`);
    } else {
      for (const target of file.targets) {
        covered.add(target);
        if (!targets.has(target)) problems.push(`${file.path}: target ${target} is not in targets`);
      }
    }
    if (typeof file.kind !== 'string' || file.kind === '') problems.push(`${file.path}: kind is missing`);
    else if (!PAYLOAD_FILE_KIND_SET.has(file.kind)) {
      problems.push(`${file.path}: kind ${file.kind} is not a known file kind`);
    }
    if (file.origin !== 'generated' && file.origin !== 'asset') {
      problems.push(`${file.path}: origin must be generated or asset`);
    }
    const member = entries.get(`files/${file.path}`);
    if (member === undefined) {
      problems.push(`payload file is listed but missing: ${file.path}`);
      continue;
    }
    if (member.mode !== file.mode) problems.push(`${file.path}: archive mode ${member.mode} != manifest ${file.mode}`);
    if (sha256Hex(Buffer.from(member.data)) !== file.sha256) {
      problems.push(`${file.path}: archive hash does not match the manifest`);
    }
  }
  for (const target of manifest?.targets ?? []) {
    if (!covered.has(target)) problems.push(`payload target ${target} has no files`);
  }
  return problems;
}

/**
 * Rebuild the projection result the publisher validated from the payload
 * manifest + members. The caller must run V1–V12 before installing; this
 * function only refuses structurally unusable input.
 */
export function resultFromPayload(manifest, entries) {
  const problems = [];
  if (manifest === null || typeof manifest !== 'object') {
    return { result: null, problems: ['payload manifest is missing'] };
  }
  const block = manifest.result;
  if (block === null || typeof block !== 'object') {
    return { result: null, problems: [`${PAYLOAD_MANIFEST_NAME} has no result block; rebuild the Release`] };
  }
  for (const field of RESULT_BLOCK_FIELDS) {
    if (!Object.hasOwn(block, field)) problems.push(`${PAYLOAD_MANIFEST_NAME} result.${field} is missing`);
  }
  if (problems.length > 0) return { result: null, problems };

  const files = [];
  for (const declared of manifest.files ?? []) {
    const member = entries.get(`files/${declared.path}`);
    if (member === undefined) {
      problems.push(`payload file is listed but missing: ${declared.path}`);
      continue;
    }
    const file = {
      path: declared.path,
      kind: declared.kind,
      targets: [...declared.targets],
      mode: declared.mode,
      origin: declared.origin,
    };
    if (declared.assetId !== undefined) file.assetId = declared.assetId;
    file.content = Buffer.from(member.data).toString('utf8');
    files.push(file);
  }
  if (problems.length > 0) return { result: null, problems };

  const result = {};
  for (const field of RESULT_FIELDS) {
    if (field === 'files') {
      result.files = files;
      continue;
    }
    result[field] = block[field];
  }
  return { result, problems };
}
