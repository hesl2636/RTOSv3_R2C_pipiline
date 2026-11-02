/**
 * agent-native projection (spec §10, decisions #71/#72/#73/#82).
 *
 * Pure: IR + resolved options in, declarative file set out. Every byte is
 * derived from the IR and the descriptor registry; nothing is read from disk
 * or the clock. The #95 slice ships the Claude Code target; #96–#99 append
 * descriptors and their capability rows.
 */
import { canonicalJson } from '../../../core/canonical-json.js';
import { compareCodePoints } from '../../../core/code-point.js';
import { constitutionBlock, constitutionState } from '../../shared/constitution.js';
import { ensureText, renderRole, ROLE_FIELD_ORDER, yamlScalar } from '../../shared/render-role.js';
import { sha256Hex } from '../../shared/sha256.js';
import { replaceSubmitToken, submitReplacement } from '../../shared/submit.js';
import { TARGETS, TARGET_ORDER } from './targets/index.js';

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CAPABILITIES = [
  'state',
  'gates',
  'outputs',
  'subagents',
  'skills',
  'preload',
  'stage-invocation',
  'skill-invocation',
];
const SEMANTIC = new Set(['state', 'gates', 'outputs', 'subagents', 'skills', 'preload']);
const LEVEL_RANK = { native: 0, adapted: 1, degraded: 2, unavailable: 3 };

function sorted(values) {
  return [...values].sort(compareCodePoints);
}

function failure(errors) {
  return { ok: false, errors };
}

function nameError(code, message, extra = {}) {
  return { code, message, ...extra };
}

function assertSupportedTarget(target) {
  const descriptor = TARGETS[target];
  if (descriptor === undefined) {
    throw new Error(`PROJECTION_TARGET_UNKNOWN: ${target}`);
  }
  if (typeof descriptor.renderTargetFiles !== 'function') {
    throw new Error(`PROJECTION_INTERNAL: target ${target} has no renderTargetFiles hook`);
  }
  return descriptor;
}

export function projectAgentNative(input) {
  const { ir, irDigest, options } = input;
  if (ir === null || typeof ir !== 'object' || ir.schema !== 'r2c.ir/v1') {
    return failure([nameError('PROJECTION_IR_UNSUPPORTED', 'input is not an r2c.ir/v1 document')]);
  }
  if (options === null || typeof options !== 'object') {
    return failure([nameError('PROJECTION_OPTIONS_INVALID', 'normalized options are required')]);
  }

  const targets = [...options.targets];
  for (const target of targets) assertSupportedTarget(target);
  const selectedSkills = new Set(options.skills);
  const allSkills = sorted(Object.keys(ir.skills ?? {}));
  const excludedSkills = allSkills.filter((id) => !selectedSkills.has(id));
  const stageOrder = [...options.stageOrder];
  const stageById = new Map(ir.stages.map((stage) => [stage.id, stage]));
  const renderedStageOrder = stageOrder.map((id) => stageById.get(id));
  if (renderedStageOrder.some((stage) => stage === undefined)) {
    return failure([nameError('PROJECTION_IR_UNSUPPORTED', 'stageOrder references a stage that is not in the IR')]);
  }
  const coverageSteps = renderedStageOrder.flatMap((stage) => stage.steps.map((step) => step.id));

  const roleIds = sorted(Object.keys(ir.roles ?? {}));
  const workflowName = `${ir.id}-workflow`;
  const stageNames = ir.stages.map((stage) => `${ir.id}-stage-${stage.id}`);
  const skillNames = new Map([...selectedSkills].map((id) => [id, `${ir.id}-skill-${id}`]));
  const roleNames = roleIds.map((id) => `${ir.id}-${id}`);

  // --- names: kebab, <=64, cross-kind unique within a target --------------
  const nameErrors = [];
  const checkName = (name, pointer, target) => {
    if (!ID_RE.test(name) || [...name].length > 64) {
      nameErrors.push(nameError(
        'PROJECTION_NAME_TOO_LONG',
        `rendered name ${name} is not a kebab id of at most 64 characters (${[...name].length})`,
        target === undefined ? { pointer } : { target, pointer },
      ));
    }
  };
  checkName(workflowName, '/id');
  for (const [index, stage] of ir.stages.entries()) {
    checkName(`${ir.id}-stage-${stage.id}`, `/stages/${index}`);
  }
  for (const skillId of selectedSkills) checkName(skillNames.get(skillId), `/skills/${skillId}`);
  for (const roleId of roleIds) checkName(`${ir.id}-${roleId}`, `/roles/${roleId}`);
  for (const target of targets) {
    const seen = new Set();
    for (const name of [workflowName, ...stageNames, ...sorted([...selectedSkills].map((id) => skillNames.get(id))), ...roleNames]) {
      if (seen.has(name)) {
        nameErrors.push(nameError(
          'PROJECTION_ID_COLLISION',
          `rendered name ${name} is used by more than one artifact kind in ${target}`,
          { target },
        ));
      }
      seen.add(name);
    }
  }
  if (nameErrors.length > 0) return failure(nameErrors);

  // --- files ---------------------------------------------------------------
  const files = [];
  const addFile = (path, fileTargets, kind, content) => {
    files.push({
      path,
      targets: fileTargets,
      kind,
      content: ensureText(content, path),
      mode: 0o644,
      origin: 'generated',
    });
  };

  // Targets sharing a skills root share one byte-identical copy per artifact.
  const skillGroups = new Map();
  for (const target of targets) {
    const root = TARGETS[target].layout.skillsRoot;
    if (!skillGroups.has(root)) skillGroups.set(root, []);
    skillGroups.get(root).push(target);
  }
  const skillRoots = [...skillGroups.keys()];

  const constitutionMount = (ir.constitution ?? [])[0] ?? null;
  constitutionState(ir.constitution ?? []);

  // --- stage skills: constitution block first, then one section per step --
  const stageContents = new Map();
  for (const [index, stage] of renderedStageOrder.entries()) {
    const blocks = [];
    if (constitutionMount !== null) blocks.push(constitutionBlock(constitutionMount));
    blocks.push(`# 阶段 ${index + 1}/${renderedStageOrder.length}：${stage.name}（\`${stage.id}\`）\n`);
    if (stage.description !== undefined) blocks.push(`${stage.description}\n`);
    blocks.push('> 无 runner：本阶段的状态、门禁执行与提交回执由执行者维护；下一阶段在它自己的技能里。\n');

    for (const [stepIndex, step] of stage.steps.entries()) {
      const bullets = [`## 步骤 ${stepIndex + 1}/${stage.steps.length}：${step.name}（\`${step.id}\`）\n`];
      if (step.role === undefined) {
        bullets.push('- 执行者：主会话直接执行。');
      } else {
        bullets.push(`- 执行者：子 agent \`${ir.id}-${step.role}\`（派发时把本文开头的宪法块与本步骤全文一并交给它）。`);
      }
      const stepSkills = sorted(step.skills.filter((id) => selectedSkills.has(id)).map((id) => skillNames.get(id)));
      if (stepSkills.length > 0) {
        bullets.push(`- 先加载技能：${stepSkills.map((name) => `\`${name}\``).join('、')}`);
      }
      if (step.gates.length > 0) {
        if (step.gates.length === 1) bullets.push('- 门禁（在项目根运行；任一非零退出 = 不得提交）：');
        for (const [gateIndex, gate] of step.gates.entries()) {
          if (step.gates.length > 1) bullets.push(`- 门禁 ${gateIndex + 1}（在项目根运行；非零退出 = 不得提交）：`);
          bullets.push('  ```bash');
          for (const line of gate.command.split('\n')) bullets.push(`  ${line}`);
          bullets.push('  ```');
          if (gate.timeout !== undefined) bullets.push(`  超时：${gate.timeout} 秒`);
        }
      }
      if (step.outputs.length > 0) {
        bullets.push(`- 提交前必须存在：${step.outputs.map((glob) => `\`${glob}\``).join('、')}`);
      }
      blocks.push(`${bullets.join('\n')}\n`);

      const task = ir.tasks[step.task];
      if (task === undefined) {
        return failure([nameError('PROJECTION_IR_UNSUPPORTED', `step ${step.id} references missing task ${step.task}`)]);
      }
      const { text } = submitReplacement({ taskId: step.task, stepIds: [step.id], mode: 'receipt' });
      let body;
      try {
        body = replaceSubmitToken(task.body, text);
      } catch (error) {
        return failure([nameError('PROJECTION_IR_UNSUPPORTED', `task ${step.task}: ${error.message}`)]);
      }
      const bodyText = body.endsWith('\n') ? body : `${body}\n`;
      blocks.push(`<!-- task:${step.task} -->\n${bodyText.startsWith('\n') ? bodyText : `\n${bodyText}`}`);
    }
    const description = `阶段 ${index + 1}/${renderedStageOrder.length}「${stage.name}」的完整运行手册（${stage.steps.length} 个步骤，含任务书、门禁与产物自检）。`;
    const frontmatter = `---\nname: ${yamlScalar(`${ir.id}-stage-${stage.id}`)}\ndescription: ${yamlScalar(description)}\n---\n\n`;
    stageContents.set(stage.id, frontmatter + blocks.join('\n'));
  }

  // --- entry skill: no constitution block ---------------------------------
  const workflowDescription = `运行 ${ir.name}（${ir.id}）全流程：${renderedStageOrder.length} 个阶段按顺序执行；agent-native 投影，无 runner。`;
  const workflowLines = [
    '---',
    `name: ${yamlScalar(workflowName)}`,
    `description: ${yamlScalar(workflowDescription)}`,
    '---',
    '',
    `# ${ir.name}（\`${ir.id}\`）`,
    '',
    ir.description,
    '',
    '本工作流没有 runner：进度由执行者维护，没有状态文件。按顺序执行下列阶段技能，',
    '**上一阶段给出提交回执后才进入下一个**；每个阶段技能开头就是项目宪法块。',
    '',
    ...renderedStageOrder.map((stage, index) => `${index + 1}. \`${ir.id}-stage-${stage.id}\` — ${stage.name}`),
    '',
    '单跑某一步或某个技能是允许的（各技能可独立加载），但那不会改变流程顺序。',
    '',
  ].join('\n');

  // --- skill copies: name/description/placeholder + verbatim body ----------
  const skillContents = new Map();
  for (const skillId of allSkills) {
    if (!selectedSkills.has(skillId)) continue;
    const skill = ir.skills[skillId];
    skillContents.set(skillId, [
      '---',
      `name: ${yamlScalar(skillNames.get(skillId))}`,
      `description: ${yamlScalar(skill.description)}`,
      `placeholder: ${skill.placeholder}`,
      '---',
      skill.body,
    ].join('\n'));
  }

  for (const [root, group] of skillGroups) {
    addFile(`${root}/${workflowName}/SKILL.md`, group, 'workflow', workflowLines);
    for (const stage of renderedStageOrder) {
      addFile(`${root}/${ir.id}-stage-${stage.id}/SKILL.md`, group, 'stage', stageContents.get(stage.id));
    }
    for (const skillId of sorted(selectedSkills)) {
      addFile(`${root}/${ir.id}-skill-${skillId}/SKILL.md`, group, 'skill', skillContents.get(skillId));
    }
  }

  // --- roles ---------------------------------------------------------------
  const roleResults = new Map();
  const roleArtifacts = new Map();
  const extraArtifacts = {};
  const degradations = [];
  const warnings = [];
  const addWarning = (warning) => warnings.push(warning);

  const ctx = {
    namespace: ir.id,
    skillNames,
    targets: TARGETS,
    roleModels: undefined,
    roleEfforts: undefined,
    trailer: undefined,
  };

  for (const target of targets) {
    const renderedByRole = new Map();
    const descriptor = TARGETS[target];
    for (const roleId of roleIds) {
      const role = { ...ir.roles[roleId], id: roleId };
      let rendered;
      try {
        rendered = renderRole(role, target, ctx);
      } catch (error) {
        return failure([nameError(error.code ?? 'PROJECTION_INTERNAL', error.message, { target, pointer: `/roles/${roleId}` })]);
      }
      renderedByRole.set(roleId, rendered);
      for (const [field, state] of Object.entries(rendered.fields)) {
        if (field === 'skills') continue;
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
      if (rendered.exposure === 'skipped') {
        addWarning({
          code: 'ROLE_EXPOSURE_SKIPPED',
          target,
          pointer: `/roles/${roleId}`,
          message: `role ${roleId} declares mode=primary; ${target} has no primary-session agent entry, so the role is not rendered`,
        });
      }
    }
    roleResults.set(target, renderedByRole);
    const renderedTargetFiles = descriptor.renderTargetFiles({ ir, roleIds, renderedByRole, descriptor });
    const contents = new Map(renderedTargetFiles.files.map((file) => [file.path, file.content]));
    for (const file of renderedTargetFiles.files) addFile(file.path, [target], file.kind, file.content);
    const artifacts = {};
    for (const [roleId, artifact] of Object.entries( renderedTargetFiles.artifacts)) {
      if (artifact === null) {
        artifacts[roleId] = null;
        continue;
      }
      artifacts[roleId] = {
        path: artifact.path,
        format: artifact.format,
        sha256: sha256Hex(contents.get(artifact.path)),
      };
    }
    roleArtifacts.set(target, artifacts);
    for (const [key, path] of Object.entries( renderedTargetFiles.metadataArtifacts ?? {})) extraArtifacts[key] = path;
  }

  // --- roles.json: one file, sectioned by selected target -----------------
  const rolesJsonPath = `.agents/agent-native/${ir.id}/roles.json`;
  const rolesTargets = {};
  for (const target of sorted(targets)) {
    const renderedByRole = roleResults.get(target);
    const artifacts = roleArtifacts.get(target);
    const roles = [];
    for (const roleId of roleIds) {
      const value = renderedByRole.get(roleId);
      const artifact = artifacts[roleId] ?? null;
      const fields = {};
      for (const field of ROLE_FIELD_ORDER) {
        if (value.fields[field] !== undefined) fields[field] = value.fields[field];
      }
      roles.push({
        id: roleId,
        name: value.name,
        placeholder: ir.roles[roleId].placeholder,
        exposure: value.exposure,
        artifact,
        fields,
      });
    }
    const summary = { roles: roles.length, native: 0, adapted: 0, degraded: 0, unavailable: 0 };
    for (const role of roles) {
      for (const state of Object.values(role.fields)) summary[state.state] += 1;
    }
    rolesTargets[target] = { namespace: ir.id, roles, summary };
  }
  addFile(rolesJsonPath, targets, 'metadata', canonicalJson({
    schema: 'r2c.projection.roles/v1',
    ir: { id: ir.id, version: ir.version, sha256: irDigest },
    targets: rolesTargets,
  }));

  // --- option exclusions and capability losses ----------------------------
  for (const target of targets) {
    for (const skillId of excludedSkills) {
      degradations.push({
        code: 'CAP_SKILL_EXCLUDED',
        target,
        capability: 'skills',
        level: 'unavailable',
        pointer: `/skills/${skillId}`,
        reason: '按投影选项 options.skills 排除',
        effect: '该技能不安装；引用它的步骤只能用内置能力自行执行，或跳过该技能',
      });
    }
    degradations.push({
      code: 'CAP_STATE_UNAVAILABLE',
      target,
      capability: 'state',
      level: 'unavailable',
      pointer: '',
      reason: 'agent-native 不生成 runner，没有状态机',
      effect: '没有进度文件、暂停/续跑或阶段强制；提交退化为自证回执',
    });
    for (const [stageIndex, stage] of ir.stages.entries()) {
      for (const [stepIndex, step] of stage.steps.entries()) {
        for (const gateIndex of step.gates.keys()) {
          degradations.push({
            code: 'CAP_GATES_ADVISORY',
            target,
            capability: 'gates',
            level: 'degraded',
            pointer: `/stages/${stageIndex}/steps/${stepIndex}/gates/${gateIndex}`,
            reason: '无 runner 执行命令，也没有东西能强制提交',
            effect: '门禁命令原样写进阶段技能，由执行者运行并在回执贴出输出与退出码',
          });
        }
        for (const outputIndex of step.outputs.keys()) {
          degradations.push({
            code: 'CAP_OUTPUTS_ADVISORY',
            target,
            capability: 'outputs',
            level: 'degraded',
            pointer: `/stages/${stageIndex}/steps/${stepIndex}/outputs/${outputIndex}`,
            reason: '无 runner 在提交前检查 glob',
            effect: '产物 glob 原样写进阶段技能，回执逐项写存在/缺失',
          });
        }
      }
    }
    const preloadLevel = TARGETS[target].capabilities.preload;
    for (const roleId of roleIds) {
      const role = ir.roles[roleId];
      const skillRefs = role.skills ?? [];
      for (const [index, skillId] of skillRefs.entries()) {
        if (!selectedSkills.has(skillId)) {
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
        } else if (LEVEL_RANK[preloadLevel] >= LEVEL_RANK.degraded) {
          degradations.push({
            code: 'CAP_PRELOAD_UNAVAILABLE',
            target,
            capability: 'preload',
            level: preloadLevel,
            pointer: `/roles/${roleId}/skills/${index}`,
            field: 'skills',
            reason: `${target} 没有按 agent 预载技能的接缝`,
            effect: '预载丢弃；技能仍在会话内可调用',
          });
        }
      }
    }
  }

  // --- capability report ---------------------------------------------------
  const capabilityReport = [];
  for (const target of targets) {
    for (const capability of CAPABILITIES) {
      const declared = TARGETS[target].capabilities[capability];
      let level = declared;
      if (capability === 'skills' || capability === 'preload') {
        for (const record of degradations) {
          if (record.target !== target || record.capability !== capability) continue;
          if (record.code !== 'CAP_SKILL_EXCLUDED' && record.code !== 'CAP_PRELOAD_EXCLUDED') continue;
          if (LEVEL_RANK[record.level] > LEVEL_RANK[level]) level = record.level;
        }
      }
      let uses = [];
      if (capability === 'state') uses = [''];
      else if (capability === 'gates') {
        uses = ir.stages.flatMap((stage, stageIndex) => stage.steps.flatMap((step, stepIndex) => step.gates.map((_, gateIndex) => `/stages/${stageIndex}/steps/${stepIndex}/gates/${gateIndex}`)));
      } else if (capability === 'outputs') {
        uses = ir.stages.flatMap((stage, stageIndex) => stage.steps.flatMap((step, stepIndex) => step.outputs.map((_, outputIndex) => `/stages/${stageIndex}/steps/${stepIndex}/outputs/${outputIndex}`)));
      } else if (capability === 'subagents') {
        uses = ir.stages.flatMap((stage, stageIndex) => stage.steps.flatMap((step, stepIndex) => (step.role === undefined ? [] : [`/stages/${stageIndex}/steps/${stepIndex}/role`])));
      } else if (capability === 'skills' || capability === 'skill-invocation') {
        uses = sorted(selectedSkills).map((id) => `/skills/${id}`);
      } else if (capability === 'preload') {
        for (const roleId of roleIds) {
          const role = ir.roles[roleId];
          for (const [index, skillId] of (role.skills ?? []).entries()) {
            if (selectedSkills.has(skillId)) uses.push(`/roles/${roleId}/skills/${index}`);
          }
        }
        uses = sorted(uses);
      } else if (capability === 'stage-invocation') {
        uses = ir.stages.map((_, index) => `/stages/${index}`);
      }
      capabilityReport.push({ target, capability, level, uses: sorted(uses) });
    }
  }

  // --- warnings (never the bundle-layer constitution placeholder) ---------
  if (options.stageOrder.some((id, index) => id !== ir.stages[index]?.id)) {
    addWarning({ code: 'STAGE_ORDER_OVERRIDDEN', message: 'options.stageOrder differs from IR order; rendering order follows the option' });
  }
  if (ir.id === 'r2c') {
    addWarning({
      code: 'NAMESPACE_SHARED_WITH_R2C',
      message: 'bundle.id is "r2c"; role paths and names overlap with the r2c projection',
    });
  }
  if (skillGroups.size > 1) {
    const mirroring = targets.filter((target) => TARGETS[target].mirrorsSharedSkills === true);
    if (mirroring.length > 0) {
      addWarning({
        code: 'SKILL_MIRRORED_ROOTS',
        target: mirroring[0],
        message: `skills are written byte-identically to ${skillRoots.join(' and ')}; ${mirroring[0]} may list the same skill twice (content identical, display only)`,
      });
    }
  }

  // --- metadata ------------------------------------------------------------
  const idMap = {};
  for (const target of targets) {
    idMap[target] = {
      stages: {},
      steps: {},
      roles: Object.fromEntries(roleIds.map((roleId) => [roleId, `${ir.id}-${roleId}`])),
      skills: Object.fromEntries(sorted(selectedSkills).map((skillId) => [skillId, skillNames.get(skillId)])),
    };
  }

  let pickSkillRoot = skillRoots[0];
  for (const [root, group] of skillGroups) {
    if (group.length > (skillGroups.get(pickSkillRoot)?.length ?? 0)) pickSkillRoot = root;
  }
  const artifacts = {
    workflow: `${pickSkillRoot}/${workflowName}/SKILL.md`,
    'roles-json': rolesJsonPath,
  };
  for (const stage of renderedStageOrder) {
    artifacts[`stage-${stage.id}`] = `${pickSkillRoot}/${ir.id}-stage-${stage.id}/SKILL.md`;
  }
  for (const skillId of sorted(selectedSkills)) {
    artifacts[`skill-${skillId}`] = `${pickSkillRoot}/${ir.id}-skill-${skillId}/SKILL.md`;
  }
  for (const [key, path] of Object.entries(extraArtifacts)) artifacts[key] = path;
  const sortedArtifacts = Object.fromEntries(sorted(Object.keys(artifacts)).map((key) => [key, artifacts[key]]));

  const skillsRoots = {};
  const targetGroups = {};
  for (const target of targets) {
    skillsRoots[target] = TARGETS[target].layout.skillsRoot;
    const group = TARGETS[target].layout.group;
    (targetGroups[group] ??= []).push(target);
  }

  const placeholders = {
    roles: roleIds.filter((id) => ir.roles[id].placeholder),
    skills: allSkills.filter((id) => ir.skills[id].placeholder),
    constitution: constitutionState(ir.constitution ?? []),
  };

  return {
    ok: true,
    targets,
    coverage: { stages: renderedStageOrder.map((stage) => stage.id), steps: coverageSteps },
    files,
    capabilityReport,
    degradations,
    warnings,
    metadata: {
      idMap,
      artifacts: sortedArtifacts,
      placeholders,
      runtime: {
        namespace: ir.id,
        targetGroups,
        skillsRoots,
        constitutionPlacement: 'stage-skill-prefix',
        submitProtocol: 'receipt-v1',
      },
    },
  };
}

export { CAPABILITIES, LEVEL_RANK, SEMANTIC, TARGET_ORDER };
