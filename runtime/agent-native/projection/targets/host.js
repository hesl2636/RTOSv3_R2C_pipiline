/**
 * Host integration data shared by the target descriptors (pure).
 *
 * Discovery ("detect") and the post-install smoke expectations are data, not
 * filesystem code: the descriptors stay browser-safe and the installer/doctor
 * composition roots are the only places that touch disk. Target assets are
 * declared here with their sha256 so `targets.test.js` can prove the bytes did
 * not drift when the tree moved from `adapters/<id>/assets` in P6.
 */

/** Freeze one host integration block onto a target descriptor. */
export function hostProfile({ detect, assets, smoke }) {
  return Object.freeze({
    detect: Object.freeze(detect),
    assets: Object.freeze(assets.map((asset) => Object.freeze(asset))),
    smoke,
  });
}

/**
 * The expected files of one agent-native target after an install.
 *
 * `namespace` is the bundle id written into the projection output. Each entry
 * is `{kind, root, prefix, format}`; `format` is `skill`, `md`, `toml`,
 * `json` or `yaml` and tells the checker which structural guarantee applies.
 */
export function layoutSmoke(namespace, { skillsRoot, agentsRoot = null, agentFormat = 'md', extra = [] }) {
  const smoke = [{ kind: 'skills', root: skillsRoot, prefix: '', format: 'skill' }];
  if (agentsRoot !== null) {
    smoke.push({ kind: 'agents', root: agentsRoot, prefix: '', format: agentFormat });
  }
  smoke.push({ kind: 'metadata', root: '.agents/agent-native', prefix: `${namespace}/roles.json`, format: 'json' });
  return [...smoke, ...extra];
}
