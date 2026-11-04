/**
 * `requires.engine` evaluation (spec §13), shared by the web build and the
 * installer.
 *
 * The range constrains the **engine** version (`runtime/runner/engine/package.json`),
 * never the framework version: the two ship independently. An absent range is
 * no constraint; an unreadable version or an invalid range is
 * `PROJECTION_ENGINE_UNKNOWN`; an unsatisfied range is
 * `PROJECTION_ENGINE_UNSATISFIED`.
 */
import { isValidRange, isValidVersion, satisfiesRange } from '../core/semver.js';

/**
 * @param {{ range?: string|null, engineVersion?: string|null }} input
 * @returns {{ok: true} | {ok: false, code: string, message: string}}
 */
export function checkEngineRequirement({ range, engineVersion } = {}) {
  if (range === undefined || range === null) return { ok: true };
  if (typeof range !== 'string' || !isValidRange(range)) {
    return {
      ok: false,
      code: 'PROJECTION_ENGINE_UNKNOWN',
      message: `requires.engine is not a valid range: ${JSON.stringify(range)}`,
    };
  }
  if (typeof engineVersion !== 'string' || !isValidVersion(engineVersion)) {
    return {
      ok: false,
      code: 'PROJECTION_ENGINE_UNKNOWN',
      message: `cannot read the engine version; requires.engine ${range}`,
    };
  }
  if (!satisfiesRange(range, engineVersion)) {
    return {
      ok: false,
      code: 'PROJECTION_ENGINE_UNSATISFIED',
      message: `requires.engine ${range} is not satisfied by engine ${engineVersion}`,
    };
  }
  return { ok: true };
}
