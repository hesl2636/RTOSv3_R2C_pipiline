import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renameIntoPlace } from '../src/rename.js';

function coded(code) {
  return Object.assign(new Error(`simulated ${code}`), { code });
}

test('a transient Windows sharing violation is retried until the rename lands', () => {
  let calls = 0;
  let waits = 0;
  renameIntoPlace('temp', 'target', {
    attempts: 3,
    delayMs: 1,
    wait: () => { waits += 1; },
    rename: () => {
      calls += 1;
      if (calls < 3) throw coded('EPERM');
    },
  });
  assert.equal(calls, 3);
  assert.equal(waits, 2);
});

test('a non-transient rename error is not retried', () => {
  let calls = 0;
  assert.throws(
    () => renameIntoPlace('temp', 'target', {
      attempts: 5,
      wait: () => {},
      rename: () => { calls += 1; throw coded('ENOENT'); },
    }),
    /ENOENT/,
  );
  assert.equal(calls, 1);
});

test('exhausted retries fall back to unlinking the target once', () => {
  let calls = 0;
  let unlinked = null;
  renameIntoPlace('temp', 'target', {
    attempts: 2,
    allowUnlink: true,
    delayMs: 1,
    wait: () => {},
    unlink: (target) => { unlinked = target; },
    rename: () => {
      calls += 1;
      if (calls <= 2) throw coded('EBUSY');
    },
  });
  assert.equal(unlinked, 'target');
  assert.equal(calls, 3);
});
