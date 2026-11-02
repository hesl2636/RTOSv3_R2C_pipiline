/**
 * Deterministic ustar+gzip container for bundle release payloads (#105, #74 §3.5).
 *
 * The implementation moved to `installer/release-tar.js` (#106) so the
 * installer can unpack a Release payload without reaching into `scripts/`;
 * this module keeps the packager's import path and its byte contract.
 */
export { createReleaseTarGz, readReleaseTarGz, releasePathProblem } from '../../installer/release-tar.js';
