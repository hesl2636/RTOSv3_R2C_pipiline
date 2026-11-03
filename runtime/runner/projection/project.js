/**
 * runner projection: IR -> project-root payload (#70, spec §9, #93).
 *
 * Pure: IR + resolved options in, declarative file set out. Only the five
 * `writeRoots` are produced; engine assets (`commands/`, `adapters/`,
 * `schema/`, `shims/`, `hm2b-payload.json`) belong to the installer.
 */
import { checkEngineRequirement } from '../../../projection/engine-requirement.js';
import { constitutionBlock, constitutionState } from '../../shared/constitution.js';
import { placeholderInstructions } from '../../shared/placeholder.js';
import { countSubmitTokens, replaceSubmitToken, submitReplacement } from '../../shared/submit.js';
import { ensureText } from '../../shared/render-role.js';
import { dumpWorkflowYaml } from '../../shared/yaml.js';
import { RUNNER_CAPABILITIES, RUNNER_MANIFEST } from './manifest.js';
import { sorted } from '../../../core/sort.js';

const TARGET = 'runner';
const RUNNER_COMMAND = 'node .hm2b/bin/hm2b.js';
const ROLE_NAME_MAX = 64;
const ROLE_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MANIFEST_TARGET = RUNNER_MANIFEST.targets[0];

function failure(errors) {
  return { ok: false, errors };
}

function nameError(code, message, extra = {}) {
  return { code, message, ...extra };
}

function quote(value) {
  return JSON.stringify(String(value));
}

function recordOf(pairs) {
  const map = new Map(pairs);
  return Object.fromEntries(sorted([...map.keys()]).map((key) => [key, map.get(key)]));
}

function checkRoleName(roleId) {
  const name = `${TARGET}-${roleId}`;
  if (!ROLE_ID_RE.test(name) || [...name].length > ROLE_NAME_MAX) {
    return nameError(
      'ROLE_NAME_TOO_LONG',
      `rendered role name ${name} is not a kebab id of at most ${ROLE_NAME_MAX} characters (${[...name].length})`,
      { target: TARGET, pointer: `/roles/${roleId}` },
    );
  }
  return null;
}

/** The static capability level from the manifest, worsened only by option loss. */
function capabilityLevel(capability, excludedSkills) {
  if (capability === 'skills' && excludedSkills.length > 0) return 'unavailable';
  return MANIFEST_TARGET.capabilities[capability].level;
}

function capabilityUses(capability, ir, allSkills, selectedSkills) {
  const stages = ir.stages ?? [];
  if (capability === 'state') return [''];
  if (capability === 'gates') {
    return stages.flatMap((stage, stageIndex) => stage.steps.flatMap((step, stepIndex) => step.gates.map((_, gateIndex) => `/stages/${stageIndex}/steps/${stepIndex}/gates/${gateIndex}`)));
  }
  if (capability === 'outputs') {
    return stages.flatMap((stage, stageIndex) => stage.steps.flatMap((step, stepIndex) => step.outputs.map((_, outputIndex) => `/stages/${stageIndex}/steps/${stepIndex}/outputs/${outputIndex}`)));
  }
  if (capability === 'subagents') {
    return stages.flatMap((stage, stageIndex) => stage.steps.flatMap((step, stepIndex) => (step.role === undefined ? [] : [`/stages/${stageIndex}/steps/${stepIndex}/role`])));
  }
  if (capability === 'skills' || capability === 'skill-invocation') {
    return allSkills.map((id) => `/skills/${id}`);
  }
  if (capability === 'preload') {
    const uses = [];
    for (const roleId of sorted(Object.keys(ir.roles ?? {}))) {
      for (const [index, skillId] of (ir.roles[roleId].skills ?? []).entries()) {
        if (selectedSkills.has(skillId)) uses.push(`/roles/${roleId}/skills/${index}`);
      }
    }
    return uses;
  }
  if (capability === 'stage-invocation') {
    return stages.map((_, index) => `/stages/${index}`);
  }
  return [];
}

function engineFailure(ir, environment) {
  const range = ir.requires?.engine;
  if (range === undefined) return null;
  const version = environment?.engineVersion;
  if (typeof version !== 'string' || version === '') {
    return nameError('PROJECTION_ENGINE_UNKNOWN', `requires.engine ${range} is declared but environment.engineVersion is unknown`);
  }
  // One evaluation (projection/engine-requirement.js) for projection, web and
  // installer; unknown/invalid inputs are reported as the projection code.
  const checked = checkEngineRequirement({ range, engineVersion: version });
  if (checked.ok) return null;
  return nameError(checked.code, checked.message);
}

export function projectRunner(input) {
  const { ir, options } = input;
  if (ir === null || typeof ir !== 'object' || ir.schema !== 'hm2b.ir/v1') {
    return failure([nameError('PROJECTION_IR_UNSUPPORTED', 'input is not an hm2b.ir/v1 document')]);
  }
  if (options === null || typeof options !== 'object' || !Array.isArray(options.stageOrder)) {
    return failure([nameError('PROJECTION_OPTIONS_INVALID', 'normalized options are required')]);
  }

  const engineError = engineFailure(ir, input.environment);
  if (engineError !== null) return failure([engineError]);

  const stages = Array.isArray(ir.stages) ? ir.stages : [];
  if (stages.length === 0) {
    return failure([nameError('PROJECTION_IR_UNSUPPORTED', 'IR must declare at least one stage', { pointer: '/stages' })]);
  }
  const stageIndex = new Map();
  const seenSteps = new Set();
  for (const [index, stage] of stages.entries()) {
    if (!Array.isArray(stage.steps) || stage.steps.length === 0) {
      return failure([nameError('PROJECTION_IR_UNSUPPORTED', `stage ${stage.id} has no steps`, { pointer: `/stages/${index}` })]);
    }
    stageIndex.set(stage.id, index);
    for (const [indexInStage, step] of stage.steps.entries()) {
      if (seenSteps.has(step.id)) {
        return failure([nameError('PROJECTION_IR_UNSUPPORTED', `duplicate step id ${step.id}`, { pointer: `/stages/${index}/steps/${indexInStage}` })]);
      }
      seenSteps.add(step.id);
    }
  }

  const stageById = new Map(stages.map((stage) => [stage.id, stage]));
  const orderedStages = options.stageOrder.map((id) => stageById.get(id));
  if (orderedStages.some((stage) => stage === undefined)) {
    return failure([nameError('PROJECTION_IR_UNSUPPORTED', 'stageOrder references a stage that is not in the IR')]);
  }

  const allSkills = sorted(Object.keys(ir.skills ?? {}));
  const selectedSkills = new Set(options.skills);
  const excludedSkills = allSkills.filter((id) => !selectedSkills.has(id));
  const roleIds = sorted(Object.keys(ir.roles ?? {}));
  for (const roleId of roleIds) {
    const problem = checkRoleName(roleId);
    if (problem !== null) return failure([problem]);
  }

  const files = [];
  const warnings = [];
  const degradations = [];
  const addFile = (path, kind, content) => {
    files.push({
      path,
      targets: [TARGET],
      kind,
      content: ensureText(content, path),
      mode: 0o644,
      origin: 'generated',
    });
  };

  // --- workflow -----------------------------------------------------------
  const workflowStages = orderedStages.map((stage) => ({
    id: stage.id,
    name: stage.name,
    steps: stage.steps.map((step) => {
      const stepDoc = { id: step.id, name: step.name, type: 'prompt' };
      if (step.role !== undefined) stepDoc.agent = `${TARGET}-${step.role}`;
      stepDoc.taskFile = `tasks/${step.task}.md`;
      if (Array.isArray(step.skills) && step.skills.length > 0) stepDoc.skills = [...step.skills];
      if (Array.isArray(step.outputs) && step.outputs.length > 0) stepDoc.expect = { outputs: [...step.outputs] };
      if (Array.isArray(step.gates) && step.gates.length > 0) {
        stepDoc.gate = step.gates.map((gate) => (gate.timeout === undefined
          ? { command: gate.command }
          : { command: gate.command, timeout: gate.timeout }));
      }
      return stepDoc;
    }),
  }));
  addFile(`workflows/${ir.id}.yaml`, 'workflow', dumpWorkflowYaml({
    schema: 'hm2b.workflow/v1',
    id: ir.id,
    name: ir.name,
    version: ir.version,
    description: ir.description,
    stages: workflowStages,
  }));

  for (const [index, stage] of stages.entries()) {
    if (stage.description !== undefined) {
      warnings.push({
        code: 'RUNNER_DISPLAY_METADATA_DROPPED',
        pointer: `/stages/${index}/description`,
        target: TARGET,
        message: `stage ${stage.id} description is display metadata and is not written to the workflow`,
      });
    }
  }

  // --- tasks --------------------------------------------------------------
  const usedBy = new Map();
  for (const stage of orderedStages) {
    for (const step of stage.steps) {
      const refs = usedBy.get(step.task) ?? [];
      refs.push(step.id);
      usedBy.set(step.task, refs);
    }
  }
  const taskIds = sorted(Object.keys(ir.tasks ?? {}));
  for (const taskId of taskIds) {
    const task = ir.tasks[taskId];
    if (countSubmitTokens(task.body) !== 1) {
      return failure([nameError(
        'PROJECTION_SUBMIT_TOKEN_COUNT',
        `task ${taskId} body must contain exactly one {{submit}} token`,
        { pointer: `/tasks/${taskId}/body` },
      )]);
    }
    const stepIds = usedBy.get(taskId) ?? [];
    const { text } = submitReplacement({ taskId, stepIds, mode: 'command' });
    addFile(`tasks/${taskId}.md`, 'task', replaceSubmitToken(task.body, text));
    if (stepIds.length !== 1) {
      warnings.push({
        code: 'RUNNER_SUBMIT_STEP_GENERIC',
        pointer: `/tasks/${taskId}`,
        target: TARGET,
        message: `task ${taskId} is referenced by ${stepIds.length} steps; the submit command uses the active step`,
      });
    }
    if (task.title !== undefined) {
      warnings.push({
        code: 'RUNNER_DISPLAY_METADATA_DROPPED',
        pointer: `/tasks/${taskId}/title`,
        target: TARGET,
        message: `task ${taskId} title is display metadata and is not written to the task file`,
      });
    }
    if (task.description !== undefined) {
      warnings.push({
        code: 'RUNNER_DISPLAY_METADATA_DROPPED',
        pointer: `/tasks/${taskId}/description`,
        target: TARGET,
        message: `task ${taskId} description is display metadata and is not written to the task file`,
      });
    }
  }

  // --- skills -------------------------------------------------------------
  for (const skillId of allSkills) {
    if (!selectedSkills.has(skillId)) continue;
    const skill = ir.skills[skillId];
    const content = [
      '---',
      `name: ${quote(skillId)}`,
      `description: ${quote(skill.description)}`,
      `placeholder: ${skill.placeholder ? 'true' : 'false'}`,
      '---',
      skill.body,
    ].join('\n');
    addFile(`skills/${skillId}/SKILL.md`, 'skill', content);
  }
  for (const skillId of excludedSkills) {
    degradations.push({
      code: 'RUNNER_SKILL_EXCLUDED',
      target: TARGET,
      capability: 'skills',
      level: 'unavailable',
      pointer: `/skills/${skillId}`,
      reason: '按投影选项排除',
      effect: '技能不安装；步骤白名单仍保留引用，引擎只 warning',
    });
  }

  // --- roles --------------------------------------------------------------
  for (const roleId of roleIds) {
    const role = ir.roles[roleId];
    const lines = ['---', `id: ${quote(roleId)}`, `agent: ${quote(`${TARGET}-${roleId}`)}`];
    if (role.description !== undefined) lines.push(`description: ${quote(role.description)}`);
    if (role.title !== undefined) lines.push(`title: ${quote(role.title)}`);
    if (role.mode !== undefined) lines.push(`mode: ${quote(role.mode)}`);
    if (role.model !== undefined) lines.push(`model: ${quote(role.model)}`);
    if (role.effort !== undefined) lines.push(`effort: ${quote(role.effort)}`);
    for (const [field, values] of [['tools', role.tools], ['tools_deny', role.tools_deny], ['skills', role.skills]]) {
      if (!Array.isArray(values) || values.length === 0) continue;
      lines.push(`${field}:`);
      for (const value of values) lines.push(`  - ${quote(value)}`);
    }
    lines.push(`placeholder: ${role.placeholder ? 'true' : 'false'}`);
    lines.push('---');
    const instructions = role.placeholder === true ? placeholderInstructions(roleId) : String(role.instructions ?? '');
    addFile(`roles/${roleId}.md`, 'role', `${lines.join('\n')}\n${instructions}`);
  }

  // --- step-role degradation (one per use point) --------------------------
  for (const stage of stages) {
    const stagePosition = stageIndex.get(stage.id);
    for (const [stepPosition, step] of stage.steps.entries()) {
      if (ir.tasks?.[step.task] === undefined) {
        return failure([nameError(
          'PROJECTION_IR_UNSUPPORTED',
          `step ${step.id} references missing task ${step.task}`,
          { pointer: `/stages/${stagePosition}/steps/${stepPosition}/task` },
        )]);
      }
      if (step.role === undefined) continue;
      if (ir.roles?.[step.role] === undefined) {
        return failure([nameError(
          'PROJECTION_IR_UNSUPPORTED',
          `step ${step.id} references missing role ${step.role}`,
          { pointer: `/stages/${stagePosition}/steps/${stepPosition}/role` },
        )]);
      }
      degradations.push({
        code: 'RUNNER_ROLE_NOT_DISPATCHED',
        target: TARGET,
        capability: 'subagents',
        level: 'degraded',
        pointer: `/stages/${stagePosition}/steps/${stepPosition}/role`,
        reason: 'runner prints the role name but never dispatches a subagent',
        effect: 'host may dispatch; runner does not enforce it',
      });
    }
  }

  // --- preload: unavailable at every selected role skill use --------------
  for (const roleId of roleIds) {
    const role = ir.roles[roleId];
    for (const [index, skillId] of (role.skills ?? []).entries()) {
      if (!selectedSkills.has(skillId)) continue;
      degradations.push({
        code: 'RUNNER_PRELOAD_UNAVAILABLE',
        target: TARGET,
        capability: 'preload',
        level: 'unavailable',
        pointer: `/roles/${roleId}/skills/${index}`,
        field: 'skills',
        reason: 'runner 投影响应最差宿主：codex/opencode/dsh 没有角色级技能预载接缝',
        effect: '支持宿主上由安装期角色渲染预载；其余宿主丢弃',
      });
    }
  }

  // --- constitution -------------------------------------------------------
  const constitutionMount = (ir.constitution ?? [])[0] ?? null;
  const constitution = constitutionState(ir.constitution ?? []);
  if (constitutionMount !== null) {
    addFile('constitution/CONSTITUTION.md', 'constitution', constitutionBlock(constitutionMount));
  }

  // --- warnings -----------------------------------------------------------
  if (options.stageOrder.some((id, index) => id !== stages[index]?.id)) {
    warnings.push({
      code: 'STAGE_ORDER_OVERRIDDEN',
      pointer: '/stages',
      target: TARGET,
      message: 'stage order was overridden by projection options',
    });
  }

  // --- metadata -----------------------------------------------------------
  const rolesMap = {};
  for (const roleId of roleIds) rolesMap[roleId] = `${TARGET}-${roleId}`;
  const artifacts = new Map([
    ['workflow', `workflows/${ir.id}.yaml`],
  ]);
  for (const taskId of taskIds) artifacts.set(`task-${taskId}`, `tasks/${taskId}.md`);
  for (const skillId of allSkills) {
    if (selectedSkills.has(skillId)) artifacts.set(`skill-${skillId}`, `skills/${skillId}/SKILL.md`);
  }
  for (const roleId of roleIds) artifacts.set(`role-${roleId}`, `roles/${roleId}.md`);
  if (constitutionMount !== null) artifacts.set('constitution', 'constitution/CONSTITUTION.md');

  const metadata = {
    idMap: {
      [TARGET]: { stages: {}, steps: {}, roles: rolesMap, skills: {} },
    },
    artifacts: recordOf([...artifacts.entries()]),
    placeholders: {
      roles: roleIds.filter((id) => ir.roles[id].placeholder),
      skills: allSkills.filter((id) => ir.skills[id].placeholder),
      constitution,
    },
    runtime: {
      runnerCommand: RUNNER_COMMAND,
      constitution: 'inline-prefix',
    },
  };

  // --- capability report --------------------------------------------------
  const capabilityReport = [];
  for (const capability of RUNNER_CAPABILITIES) {
    capabilityReport.push({
      target: TARGET,
      capability,
      level: capabilityLevel(capability, excludedSkills),
      uses: sorted(capabilityUses(capability, ir, allSkills, selectedSkills)),
    });
  }

  const coverageSteps = orderedStages.flatMap((stage) => stage.steps.map((step) => step.id));

  return {
    ok: true,
    targets: [TARGET],
    coverage: { stages: orderedStages.map((stage) => stage.id), steps: coverageSteps },
    files,
    capabilityReport,
    degradations,
    warnings,
    metadata,
  };
}
