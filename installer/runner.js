/**
 * runner install composition (#104, #82 §11, spec §12).
 *
 * `render-roles` renders the four host
 * agent definitions from the IR through `runtime/shared/render-role.js`, names
 * them `runner-<id>`, records field-level degradations and writes one
 * `.hm2b/projection/roles.json` sectioned by the host target ids that were
 * actually installed. dsh has no native role format and renders nothing.
 *
 * Runner's `preload` capability is `unavailable` (spec §9): the install never
 * creates host skill roots (`.claude/skills`, `.agents/skills`, ...), so a
 * skill name inside a host role file could never resolve. Host role files
 * therefore carry no skill names at all, every selected use is recorded as a
 * `CAP_PRELOAD_UNAVAILABLE` degradation and `roles.json` reports
 * `fields.skills: unavailable`.
 */
import { canonicalJson } from '../core/canonical-json.js';
import { sha256Hex } from '../core/node/sha256.js';
import { LEVEL_RANK } from '../projection/contract.js';
import { TARGETS } from '../runtime/agent-native/projection/targets/index.js';
import { renderRole, ROLE_FIELD_ORDER } from '../runtime/shared/render-role.js';
import { installProjection } from './install.js';
import { RUNNER_ROLE_TARGETS } from './runtime.js';
import { sorted } from '../core/sort.js';
import { IR_SCHEMA } from '../ir/schema.js';

export { RUNNER_ROLE_TARGETS };

export const ROLES_JSON_PATH = '.hm2b/projection/roles.json';

const PRELOAD_REASON = 'runner 投影的 preload 能力不可用：宿主技能根（如 .claude/skills）未安装，技能名无法解析';
const PRELOAD_FIELD_EFFECT = '角色执行时不预载技能；技能仍在会话内可调用';
const PRELOAD_USE_EFFECT = '角色执行时不预载该技能；技能仍在会话内可调用';

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
  if (ir === null || typeof ir !== 'object' || ir.schema !== IR_SCHEMA) {
    return failure('ROLES_IR_UNSUPPORTED', `renderRunnerRoles needs an ${IR_SCHEMA} document`);
  }
  if (typeof irDigest !== 'string' || irDigest === '') {
    return failure('ROLES_IR_DIGEST_MISSING', 'renderRunnerRoles needs the IR digest');
  }
  const targets = effectiveTargets(hostTargets);
  const roleIds = sorted(Object.keys(ir.roles ?? {}));
  const allSkills = Object.keys(ir.skills ?? {});
  const selected = Array.isArray(skills) ? new Set(skills) : new Set(allSkills);
  // Spec §9: runner's preload is `unavailable`, and no host skill root is
  // installed. An empty name table means the renderer can never emit a name
  // that would not resolve; roles are rendered without their `skills` field
  // below so no empty `skills: []` line is left behind either.
  const ctx = { namespace: 'runner', skillNames: new Map(), targets: TARGETS };

  const files = [];
  const degradations = [];
  const warnings = [];
  const rolesTargets = {};

  for (const target of targets) {
    const descriptor = TARGETS[target];
    const roles = [];
    for (const roleId of roleIds) {
      const declaredSkills = ir.roles[roleId].skills;
      // Host role files never name skills: the field is dropped from the render
      // input so a descriptor cannot write `skills: [unresolvable-id]` (nor an
      // empty `skills: []` line). `roles.json` still reports the declared field
      // as unavailable below.
      const role = { ...ir.roles[roleId], id: roleId };
      delete role.skills;
      let rendered;
      try {
        rendered = renderRole(role, target, ctx);
      } catch (error) {
        return failure(error.code ?? 'ROLES_RENDER_FAILED', error.message, { target, pointer: `/roles/${roleId}` });
      }

      // #82 #8: an excluded skill is a preload loss where the target has a
      // preload seam (Claude/omp); elsewhere the projection already records the
      // declared per-use loss. Every selected use is now unavailable at install
      // because runner installs no host skill root, regardless of the target's
      // own descriptor seam (spec §9).
      const hasPreloadSeam = LEVEL_RANK[TARGETS[target].capabilities.preload] <= LEVEL_RANK.adapted;
      for (const [index, skillId] of (declaredSkills ?? []).entries()) {
        if (!selected.has(skillId)) {
          if (!hasPreloadSeam) continue;
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
          continue;
        }
        degradations.push({
          code: 'CAP_PRELOAD_UNAVAILABLE',
          target,
          capability: 'preload',
          level: 'unavailable',
          pointer: `/roles/${roleId}/skills/${index}`,
          field: 'skills',
          reason: PRELOAD_REASON,
          effect: PRELOAD_USE_EFFECT,
        });
      }

      for (const [field, state] of Object.entries(rendered.fields)) {
        if (state.state !== 'degraded' && state.state !== 'unavailable') continue;
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
        if (field === 'skills' && Array.isArray(declaredSkills)) {
          fields.skills = { state: 'unavailable', reason: PRELOAD_REASON, effect: PRELOAD_FIELD_EFFECT };
          continue;
        }
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
