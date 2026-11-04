/**
 * Stand-in engine tree.
 *
 * The release installs a real engine under `.hm2b/engine/<V>/`; tests only need
 * a runnable entry at that path, so this writes `bin/hm2b.js` as a module that
 * imports the checkout's own entry point. Everything that spawns
 * `node <engine>/bin/hm2b.js` then behaves exactly like the installed engine.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Write `<home>/bin/hm2b.js` delegating to `bin`; returns the engine home. */
export function writeEngine(home, bin) {
  mkdirSync(join(home, 'bin'), { recursive: true });
  writeFileSync(join(home, 'bin', 'hm2b.js'), `import ${JSON.stringify(pathToFileURL(bin).href)};\n`);
  return home;
}
