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
  MAX_PATH_DEPTH: 3,
  MAX_TASK_BYTES: 128 * 1024,
  MAX_CONSTITUTION_BYTES: 64 * 1024,
});
