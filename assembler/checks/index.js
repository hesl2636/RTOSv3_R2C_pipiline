/**
 * Ordered bundle check registry (owned by #84, append-only).
 *
 * Modules own their diagnostics; this array owns the order. A module returns
 * early when its prerequisite set `ctx.skipped.<area>`.
 */
import { check as assets } from './assets.js';
import { check as container } from './container.js';
import { check as crossrefs } from './crossrefs.js';
import { check as entities } from './entities.js';
import { check as manifest } from './manifest.js';
import { check as stages } from './stages.js';
import { check as tasks } from './tasks.js';

export const BUNDLE_CHECKS = Object.freeze([
  Object.freeze({ id: 'container', area: 'container', check: container }),
  Object.freeze({ id: 'manifest', area: 'manifest', check: manifest }),
  Object.freeze({ id: 'assets', area: 'assets', check: assets }),
  Object.freeze({ id: 'stages', area: 'stages', check: stages }),
  Object.freeze({ id: 'tasks', area: 'tasks', check: tasks }),
  Object.freeze({ id: 'entities', area: 'entities', check: entities }),
  Object.freeze({ id: 'crossrefs', area: 'crossrefs', check: crossrefs }),
]);

export function runChecks(context) {
  for (const module of BUNDLE_CHECKS) {
    if (context.skipped[module.area] === true) continue;
    module.check(context);
  }
}
