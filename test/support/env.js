import { delimiter } from 'node:path';

/**
 * Read the inherited PATH regardless of its Windows casing. A plain
 * `env.PATH` read misses `Path`, and assigning `env.PATH` next to `Path`
 * leaves two entries in the child environment; command shims then lose every
 * system directory, including the one holding `node`.
 */
export function inheritedPath(env) {
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'path') return env[key] ?? '';
  }
  return '';
}

/** Collapse every PATH casing into one value, prepending `pathDir` when given. */
export function withPath(env, pathDir) {
  const current = inheritedPath(env);
  const next = pathDir === undefined || pathDir === null
    ? current
    : `${pathDir}${delimiter}${current}`;
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'path') delete env[key];
  }
  if (next !== '') env.PATH = next;
  return env;
}
