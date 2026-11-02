/**
 * Lazy bridge to the shared projection/runtime modules.
 *
 * The read-only slice (#108) only needs validation and IR; projection preview
 * and role rendering arrive with #93/#95. Those trees are served by the same
 * whitelist, and this module imports them by relative ESM URL (no bundler, no
 * dynamic discovery: the file names are fixed by the interface contract).
 * Missing modules degrade to `null` until their tickets land.
 */

async function attempt(specifier) {
  try {
    return await import(specifier);
  } catch {
    return null;
  }
}

/**
 * @param {{ projection?: boolean, runtimeShared?: boolean }} [availability]
 * @returns {Promise<{
 *   registry: object|null,
 *   renderRole: Function|null,
 *   constitutionState: Function|null,
 *   submitReplacement: Function|null,
 * }>}
 */
export async function loadSharedModules(availability = {}) {
  const [registry, renderRole, constitution, submit] = await Promise.all([
    availability.projection === true ? attempt('../projection/registry.js') : null,
    availability.runtimeShared === true ? attempt('../runtime/shared/render-role.js') : null,
    availability.runtimeShared === true ? attempt('../runtime/shared/constitution.js') : null,
    availability.runtimeShared === true ? attempt('../runtime/shared/submit.js') : null,
  ]);
  return {
    registry: registry ?? null,
    renderRole: typeof renderRole?.renderRole === 'function' ? renderRole.renderRole : null,
    constitutionState: typeof constitution?.constitutionState === 'function' ? constitution.constitutionState : null,
    submitReplacement: typeof submit?.submitReplacement === 'function' ? submit.submitReplacement : null,
  };
}
