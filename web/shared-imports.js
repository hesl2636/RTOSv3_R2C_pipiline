/**
 * Static bridge to the shared projection/runtime modules.
 *
 * The browser and the CLI run the same implementations, so these are plain
 * relative ESM imports — no bundler, no dynamic discovery, no optional
 * modules. `loadSharedModules` only decides which of the already-loaded
 * exports this page uses, based on the server's module availability flags.
 */
import * as registryModule from '../projection/registry.js';
import { constitutionState } from '../runtime/shared/constitution.js';
import { renderRole } from '../runtime/shared/render-role.js';
import { submitReplacement } from '../runtime/shared/submit.js';

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
  return {
    registry: availability.projection === true ? registryModule : null,
    renderRole: availability.runtimeShared === true ? renderRole : null,
    constitutionState: availability.runtimeShared === true ? constitutionState : null,
    submitReplacement: availability.runtimeShared === true ? submitReplacement : null,
  };
}
