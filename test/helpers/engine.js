/**
 * Stand-in engine tree.
 *
 * The release installs a real engine under `.r2c/engine/<V>/`; tests only need
 * a runnable entry at that path, so this writes `bin/r2c.js` as a module that
 * imports the checkout's own entry point. Everything that spawns
 * `node <engine>/bin/r2c.js` then behaves exactly like the installed engine.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Write `<home>/bin/r2c.js` delegating to `bin`; returns the engine home. */
export function writeEngine(home, bin) {
  mkdirSync(join(home, 'bin'), { recursive: true });
  writeFileSync(join(home, 'bin', 'r2c.js'), `import ${JSON.stringify(pathToFileURL(bin).href)};\n`);
  return home;
}
