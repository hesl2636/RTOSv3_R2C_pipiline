/**
 * Project-local state layout. The only runtime writes a command may perform
 * live under `<projectRoot>/.hm2b/`. `isInside` is the shared predicate from
 * `core/paths.js`, re-exported here because it is part of the engine API.
 */
import { join, resolve } from 'node:path';
import { isInside } from '../../../../core/paths.js';

export { isInside };

export function projectRoot(value) {
  return resolve(value);
}

export function hm2bDir(root) {
  return join(root, '.hm2b');
}

export function latestPath(root) {
  return join(hm2bDir(root), 'latest.json');
}

export function runsDir(root) {
  return join(hm2bDir(root), 'runs');
}

export function latestLockPath(root) {
  return join(runsDir(root), '.latest.lock');
}

export function runDir(root, runId) {
  return join(runsDir(root), runId);
}

export function statePath(root, runId) {
  return join(runDir(root, runId), 'state.json');
}

export function eventsPath(root, runId) {
  return join(runDir(root, runId), 'events.jsonl');
}

export function workflowSnapshotPath(root, runId) {
  return join(runDir(root, runId), 'workflow.yaml');
}

export function runLockPath(root, runId) {
  return join(runDir(root, runId), '.lock');
}
