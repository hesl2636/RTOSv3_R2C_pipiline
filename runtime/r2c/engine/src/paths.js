/**
 * Project-local state layout. The only runtime writes a command may perform
 * live under `<projectRoot>/.r2c/`. `isInside` is the shared predicate from
 * `core/paths.js`, re-exported here because it is part of the engine API.
 */
import { join, resolve } from 'node:path';
import { isInside } from '../../../../core/paths.js';

export { isInside };

export function projectRoot(value) {
  return resolve(value);
}

export function r2cDir(root) {
  return join(root, '.r2c');
}

export function latestPath(root) {
  return join(r2cDir(root), 'latest.json');
}

export function runsDir(root) {
  return join(r2cDir(root), 'runs');
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
