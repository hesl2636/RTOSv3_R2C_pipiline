/**
 * Child-process environment and log hygiene (decision #75 §8.1, §10.8).
 *
 * Shared by the server and its tests: build/validate children never inherit
 * GitHub credentials, and anything derived from a child is redacted before it
 * can reach a response, a log or an artifact.
 */

export const TOKEN_KEYS = Object.freeze(['GH_TOKEN', 'GITHUB_TOKEN']);

/** Copy `env` without the publish credentials (build/validate children). */
export function buildChildEnv(env) {
  const out = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (TOKEN_KEYS.includes(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Replace every known secret value and bearer-style credential with
 * `[redacted]`. Unknown token shapes are caught by the generic patterns.
 */
export function redactSecrets(text, secrets = []) {
  let out = String(text);
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0) out = out.split(secret).join('[redacted]');
  }
  return out
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{16,}/g, '[redacted]');
}
