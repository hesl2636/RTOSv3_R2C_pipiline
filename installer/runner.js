/**
 * runner install composition (#104, #82 §11, spec §12).
 *
 * `render-roles` renders the four host
 * agent definitions from the IR through `runtime/shared/render-role.js`, names
 * them `runner-<id>`, records field-level degradations and writes one
 * `.hm2b/projection/roles.json` sectioned by the host adapter ids that were
 * actually installed. dsh has no native role format and renders nothing.
 */
import { canonicalJson } from '../core/canonical-json.js';
import { sha256Hex } from '../core/node/sha256.js';
import { LEVEL_RANK } from '../projection/contract.js';
import { TARGETS } from '../runtime/agent-native/projection/targets/index.js';
import { renderRole, ROLE_FIELD_ORDER } from '../runtime/shared/render-role.js';
import { installProjection } from './install.js';
import { RUNNER_ROLE_TARGETS } from './runtime.js';
import { sorted } from '../core/sort.js';

export { RUNNER_ROLE_TARGETS };

export const ROLES_JSON_PATH = '.hm2b/projection/roles.json';

function effectiveTargets(hostTargets) {
  if (hostTargets === undefined || hostTargets === null) return [...RUNNER_ROLE_TARGETS];
  const wanted = new Set(hostTargets);
  return RUNNER_ROLE_TARGETS.filter((target) => wanted.has(target));
}

function failure(code, message, details = {}) {
  return { ok: false, code, message, ...details };
}

/**
 * Render every IR role for every installed host target.
 *
 * Returns `{targets, files, degradations, warnings, rolesJson}`; `files` are
 * installer-owned entries the receipt must record (host agents + roles.json).
 */
export function renderRunnerRoles({ ir, irDigest, hostTargets, skills } = {}) {
  if (ir === null || typeof ir !== 'object' || ir.schema !== 'hm2b.ir/v1') {
    return failure('ROLES_IR_UNSUPPORTED', 'renderRunnerRoles needs an hm2b.ir/v1 document');
  }
  if (typeof irDigest !== 'string' || irDigest === '') {
    return failure('ROLES_IR_DIGEST_MISSING', 'renderRunnerRoles needs the IR digest');
  }
  const targets = effectiveTargets(hostTargets);
  const roleIds = sorted(Object.keys(ir.roles ?? {}));
  const allSkills = Object.keys(ir.skills ?? {});
  const selected = Array.isArray(skills) ? new Set(skills) : new Set(allSkills);
  // Only selected skills get a runtime name: the renderer drops the rest, so
  // an excluded skill can never leak into a host role definition.
  const skillNames = new Map(allSkills.filter((id) => selected.has(id)).map((id) => [id, id]));
  const ctx = { namespace: 'runner', skillNames, targets: TARGETS };

  const files = [];
  const degradations = [];
  const warnings = [];
  const rolesTargets = {};

  for (const target of targets) {
    const descriptor = TARGETS[target];
    const roles = [];
    for (const roleId of roleIds) {
      const role = { ...ir.roles[roleId], id: roleId };
      let rendered;
      try {
        rendered = renderRole(role, target, ctx);
      } catch (error) {
        return failure(error.code ?? 'ROLES_RENDER_FAILED', error.message, { target, pointer: `/roles/${roleId}` });
      }

      // #82 #8: an excluded skill the role still preloads is a preload loss
      // only where the target has a preload seam (Claude/omp). Targets without
      // one never render role skills, and the projection already records their
      // declared per-use loss, so no install-time record is added.
      const hasPreloadSeam = LEVEL_RANK[TARGETS[target].capabilities.preload] <= LEVEL_RANK.adapted;
      for (const [index, skillId] of (ir.roles[roleId].skills ?? []).entries()) {
        if (selected.has(skillId) || !hasPreloadSeam) continue;
        degradations.push({
          code: 'CAP_PRELOAD_EXCLUDED',
          target,
          capability: 'preload',
          level: 'unavailable',
          pointer: `/roles/${roleId}/skills/${index}`,
          field: 'skills',
          reason: '按投影选项 options.skills 排除',
          effect: '预载正文丢弃；技能本身也未安装',
        });
      }

      for (const [field, state] of Object.entries(rendered.fields)) {
        if (state.state !== 'degraded' && state.state !== 'unavailable') continue;
        if (field === 'skills') {
          for (const [index, skillId] of (role.skills ?? []).entries()) {
            if (!skillNames.has(skillId)) continue;
            degradations.push({
              code: 'CAP_ROLE_FIELD_DEGRADED',
              target,
              capability: 'preload',
              level: state.state,
              pointer: `/roles/${roleId}/skills/${index}`,
              field: 'skills',
              reason: state.reason,
              effect: state.effect,
            });
          }
          continue;
        }
        degradations.push({
          code: 'CAP_ROLE_FIELD_DEGRADED',
          target,
          capability: 'subagents',
          level: state.state,
          pointer: `/roles/${roleId}`,
          field,
          reason: state.reason,
          effect: state.effect,
        });
      }

      let artifact = null;
      if (rendered.exposure !== 'skipped' && rendered.content !== null) {
        const path = `${descriptor.layout.agentsRoot}/${rendered.basename}`;
        files.push({
          path,
          kind: 'agent',
          targets: [target],
          mode: 0o644,
          content: rendered.content,
          source: `roles/${roleId}.md`,
          origin: 'installer',
        });
        artifact = {
          path,
          format: rendered.format,
          sha256: sha256Hex(rendered.content),
        };
      } else {
        warnings.push({
          code: 'ROLE_EXPOSURE_SKIPPED',
          target,
          pointer: `/roles/${roleId}`,
          message: `role ${roleId} is not exposed by ${target}; no agent definition was written`,
        });
      }

      const fields = {};
      for (const field of ROLE_FIELD_ORDER) {
        if (rendered.fields[field] !== undefined) fields[field] = rendered.fields[field];
      }
      roles.push({
        id: roleId,
        name: rendered.name,
        placeholder: ir.roles[roleId].placeholder === true,
        exposure: rendered.exposure,
        artifact,
        fields,
      });
    }

    const summary = { roles: roles.length, native: 0, adapted: 0, degraded: 0, unavailable: 0 };
    for (const role of roles) {
      for (const state of Object.values(role.fields)) summary[state.state] += 1;
    }
    rolesTargets[target] = { namespace: 'runner', roles, summary };
  }

  const orderedTargets = {};
  for (const target of sorted(targets)) orderedTargets[target] = rolesTargets[target];
  const rolesJson = canonicalJson({
    schema: 'hm2b.projection.roles/v1',
    ir: { id: ir.id, version: ir.version, sha256: irDigest },
    targets: orderedTargets,
  });
  files.push({
    path: ROLES_JSON_PATH,
    kind: 'metadata',
    targets: sorted(targets),
    mode: 0o644,
    content: rolesJson,
    source: 'runner/render-roles',
    origin: 'installer',
  });

  return {
    ok: true,
    targets: sorted(targets),
    files,
    degradations,
    warnings,
    rolesJson,
  };
}

/**
 * Install a runner projection result plus its installer-owned host role files.
 * Non-runner projections fall through to the generic projection installer.
 */
export function installRunnerProject(input = {}) {
  const result = input.result;
  if (result === null || typeof result !== 'object' || result.projection?.id !== 'runner') {
    return installProjection(input);
  }
  const irBytes = input.irBytes;
  if (irBytes === undefined || irBytes === null) return installProjection(input);
  const irText = typeof irBytes === 'string' ? irBytes : Buffer.from(irBytes).toString('utf8');
  let ir;
  try {
    ir = JSON.parse(irText);
  } catch {
    return installProjection(input);
  }
  const rendered = renderRunnerRoles({
    ir,
    irDigest: sha256Hex(irText),
    hostTargets: input.hostTargets ?? RUNNER_ROLE_TARGETS,
    skills: input.result?.options?.skills,
  });
  if (rendered.ok === false) {
    return rendered;
  }
  const outcome = installProjection({
    ...input,
    installerOwned: {
      files: rendered.files,
      hostTargets: rendered.targets,
      degradations: rendered.degradations,
      warnings: rendered.warnings,
    },
  });
  return { ...outcome, roles: { targets: rendered.targets, degradations: rendered.degradations } };
}
