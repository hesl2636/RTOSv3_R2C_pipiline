/**
 * Static bridge to the shared runtime module the page actually uses.
 *
 * The browser and the CLI run the same implementation, so this is a plain
 * relative ESM import — no bundler, no dynamic discovery, no optional
 * modules. `loadSharedModules` returns exactly the exports the page consumes.
 */
import { constitutionState } from '../runtime/shared/constitution.js';

/**
 * @returns {Promise<{ constitutionState: Function }>}
 */
export async function loadSharedModules() {
  return { constitutionState };
}
