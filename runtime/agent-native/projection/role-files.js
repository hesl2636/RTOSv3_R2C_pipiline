/**
 * Reusable role-file shape for descriptors (#95, #96–#99).
 *
 * Per-role targets (Claude md, Codex toml, omp/opencode md) all emit one file
 * per rendered role. A target that aggregates roles into a single catalogue
 * (dsh v1) implements its own `renderTargetFiles` hook returning the same shape:
 * `{files:[{path,kind,content}], artifacts:{<roleId>: {path,format}|null}}`.
 */

export function perRoleRoleFiles({ roleIds, renderedByRole, descriptor }) {
  const files = [];
  const artifacts = {};
  for (const roleId of roleIds) {
    const rendered = renderedByRole.get(roleId);
    if (rendered.content === null) {
      artifacts[roleId] = null;
      continue;
    }
    const path = `${descriptor.layout.agentsRoot}/${rendered.basename}`;
    files.push({ path, kind: 'agent', content: rendered.content });
    artifacts[roleId] = { path, format: rendered.format };
  }
  return { files, artifacts };
}
