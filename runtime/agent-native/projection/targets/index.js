/**
 * agent-native target registry (#95 seeds, #96–#99 append).
 *
 * Static and closed: no filesystem scan, no dynamic import. Adding a runtime
 * is adding one descriptor here plus its capability row in `projection.json`.
 */
import { claudeCodeTarget } from './claude-code.js';
import { codexTarget } from './codex.js';
import { opencodeTarget } from './opencode.js';

export const TARGETS = Object.freeze({
  'claude-code': claudeCodeTarget,
  codex: codexTarget,
  opencode: opencodeTarget,
});

export const TARGET_ORDER = Object.freeze(Object.keys(TARGETS));

export function getTarget(id) {
  return TARGETS[id];
}

export function targetOrder() {
  return [...TARGET_ORDER];
}
