/**
 * Bundle container limits (decision #67 §3). One copy for validator, compiler,
 * CLI and web; never hard-code these numbers elsewhere.
 */
export const LIMITS = Object.freeze({
  MAX_ZIP_BYTES: 8 * 1024 * 1024,
  MAX_ENTRIES: 512,
  MAX_UNCOMPRESSED_BYTES: 32 * 1024 * 1024,
  MAX_ENTRY_BYTES: 4 * 1024 * 1024,
  MAX_PATH_BYTES: 100,
  // Four segments admit `knowledge-base/<group>/<subgroup>/<file>.md`.
  MAX_PATH_DEPTH: 4,
  MAX_TASK_BYTES: 128 * 1024,
  MAX_CONSTITUTION_BYTES: 64 * 1024,
});

/**
 * Limits that apply to a specific bundle path in addition to the generic
 * per-entry cap (decision #67 §7.4/§7.8). `readZip` applies them from the
 * central directory, before inflation; the owning check modules keep their
 * own guards for contexts built without the zip reader.
 */
const KIND_LIMITS = Object.freeze([
  Object.freeze({
    pattern: /^tasks\/([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/,
    code: 'BUNDLE_TASK_TOO_LARGE',
    limit: LIMITS.MAX_TASK_BYTES,
  }),
  Object.freeze({
    pattern: /^constitution\/CONSTITUTION\.md$/,
    code: 'BUNDLE_CONSTITUTION_TOO_LARGE',
    limit: LIMITS.MAX_CONSTITUTION_BYTES,
  }),
]);

/** @returns {{code: string, limit: number}|null} */
export function entryLimitFor(path) {
  for (const rule of KIND_LIMITS) {
    if (rule.pattern.test(path)) return rule;
  }
  return null;
}
