/**
 * Static projection registry (#69 §8, CONTEXT §11).
 *
 * Discovery is a frozen array in the same build: no filesystem scan, no
 * dynamic import, no code from a bundle or a project. Only contract versions
 * are checked here; `requires.engine` remains an r2c-only runtime concern.
 */
import { compareCodePoints } from '../core/code-point.js';
import { AGENT_NATIVE_MANIFEST } from '../runtime/agent-native/projection/manifest.js';
import { projectAgentNative } from '../runtime/agent-native/projection/project.js';
import { R2C_MANIFEST } from '../runtime/r2c/projection/manifest.js';
import { projectR2c } from '../runtime/r2c/projection/project.js';

export const PROJECTIONS = Object.freeze([
  Object.freeze({
    ...AGENT_NATIVE_MANIFEST,
    project: projectAgentNative,
  }),
  Object.freeze({
    ...R2C_MANIFEST,
    project: projectR2c,
  }),
]);

export function listProjections() {
  return PROJECTIONS;
}

export function getProjection(id) {
  return PROJECTIONS.find((projection) => projection.id === id) ?? null;
}

/** The projections a bundle allows (#69 §5): IR order by default, else sorted. */
export function allowedProjections(ir) {
  const declared = ir?.requires?.projections;
  if (!Array.isArray(declared)) return ['r2c', 'agent-native'];
  return [...new Set(declared)].sort(compareCodePoints);
}

export function defaultTargets(id) {
  const projection = getProjection(id);
  if (projection === null) return [];
  const targets = projection.targets.filter((target) => target.default !== false);
  return (targets.length > 0 ? targets : projection.targets).map((target) => target.id);
}
