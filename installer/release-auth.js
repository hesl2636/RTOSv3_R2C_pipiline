/**
 * Credential hygiene for releases (#107, decision #74 §7).
 *
 * `GH_TOKEN` wins over `GITHUB_TOKEN`, and both are read only from the launch
 * environment of the composition root. Nothing here prompts, persists, falls
 * back to `git credential fill` or writes the value anywhere: a missing token
 * disables publishing, never installs or previews.
 */
export const GH_TOKEN_ENV = Object.freeze(['GH_TOKEN', 'GITHUB_TOKEN']);
export const GH_TOKEN_HINT = 'set GH_TOKEN with Contents: Write';
export const REDACTED = '[redacted]';

/** @returns {{token: string|null, source: string|null}} */
export function readGithubToken(env = process.env) {
  for (const name of GH_TOKEN_ENV) {
    const value = env?.[name];
    if (typeof value === 'string' && value.trim() !== '') return { token: value, source: name };
  }
  return { token: null, source: null };
}

/** UI/CLI gate: publishing needs a token, everything else keeps working. */
export function publishAvailability(env = process.env) {
  const { token, source } = readGithubToken(env);
  return token === null
    ? { enabled: false, reason: GH_TOKEN_HINT, source: null }
    : { enabled: true, reason: null, source };
}

/**
 * Remove a token from text that may reach stdout, stderr, a log or an error
 * message. Handles the raw value and its percent-encoded URL form.
 */
export function redactSecret(text, secrets) {
  const list = (Array.isArray(secrets) ? secrets : [secrets])
    .filter((secret) => typeof secret === 'string' && secret !== '');
  let out = String(text);
  for (const secret of list) {
    out = out.split(secret).join(REDACTED);
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) out = out.split(encoded).join(REDACTED);
  }
  return out;
}

/** True when any of `blobs` (bytes or text) contains one of `secrets`. */
export function containsSecret(blobs, secrets) {
  const list = (Array.isArray(secrets) ? secrets : [secrets])
    .filter((secret) => typeof secret === 'string' && secret !== '');
  if (list.length === 0) return false;
  for (const blob of blobs ?? []) {
    const text = Buffer.isBuffer(blob) || blob instanceof Uint8Array
      ? Buffer.from(blob).toString('utf8')
      : String(blob);
    for (const secret of list) if (text.includes(secret)) return true;
  }
  return false;
}
