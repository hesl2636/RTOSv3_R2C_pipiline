/**
 * Publish button state (decision #75 §8.3, ticket #110).
 *
 * Pure and DOM-free so the browser and the tests read the same rule: the
 * button is enabled only when the server has a credential and a repository,
 * the current build is canonical (publishable), and the browser/server
 * comparison found no defect. The server re-checks every rule independently.
 */

/**
 * @param {{publish: {enabled?: boolean, reason?: string|null, repo?: string|null}|null,
 *          build: {publishable?: boolean}|null, mismatch: boolean}} input
 * @returns {{enabled: boolean, reason: string|null, note: string|null}}
 */
export function publishAvailability({ publish = null, build = null, mismatch = false } = {}) {
  if (mismatch) {
    return { enabled: false, reason: 'client-server-mismatch', note: 'publish disabled: client/server mismatch' };
  }
  if (publish === null || publish.enabled !== true) {
    const reason = typeof publish?.reason === 'string' && publish.reason !== '' ? publish.reason : 'read-only';
    return { enabled: false, reason, note: `publish disabled (${reason})` };
  }
  if (build === null) {
    return { enabled: false, reason: 'no-build', note: 'publish disabled: build the assets first' };
  }
  if (build.publishable !== true) {
    return { enabled: false, reason: 'not-canonical', note: 'publish disabled: custom options are local only' };
  }
  return { enabled: true, reason: null, note: `publish enabled (${publish.repo})` };
}
