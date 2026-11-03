/**
 * Bundle -> canonical compiled workflow compiler (spec §5, decision #68).
 *
 * The fixed 11 steps and where they run:
 *   1 validate                 analyzeBundle (errors gate, nothing produced)
 *   2 parse manifest           analyzeBundle -> model.manifest
 *   3 freeze declarations      analyzeBundle -> model.declared
 *   4 per-file SHA-256         fileHash()
 *   5 contentSha256            contentSha256()
 *   6 parse stages/steps       analyzeBundle -> model.stages (author order)
 *   7 assets into maps         buildCompiledWorkflow() (roles/tasks/skills sorted by id)
 *   8 re-check references      analyzeBundle crossrefs + validateCompiledWorkflow self-check
 *   9 assemble in schema order buildCompiledWorkflow()
 *  10 canonical serialization  serializeCompiledWorkflow()
 *  11 self-check               validateCompiledWorkflow() + cardinalityIssues()
 *
 * The compiler never re-implements validation and never emits a partial
 * artifact: any error yields `compiledWorkflowBytes: null`.
 */
import { compareCodePoints } from '../core/code-point.js';
import { buildReport, makeDiagnostic, SEVERITY } from '../core/diagnostics.js';
import {
  COMPILED_WORKFLOW_BUNDLE_SCHEMA,
  COMPILED_WORKFLOW_FILENAME,
  COMPILED_WORKFLOW_SCHEMA,
} from '../compiled/schema.js';
import { serializeCompiledWorkflow } from '../compiled/serialize.js';
import { analyzeBundle } from './validate-bundle.js';
import { validateCompiledWorkflow } from './validate-compiled.js';
import { HOOKS_PATH, MCP_PATH, checklistPath } from './checks/assets.js';
import { sorted } from '../core/sort.js';

const encoder = new TextEncoder();

function fileHash(primitives, model, path) {
  return primitives.sha256(model.entries.get(path).data);
}

/**
 * `contentSha256` of a bundle model (step 5): the digest of the declared
 * member hashes. Exported so an installer can re-derive the zip ↔ compiled workflow binding
 * without compiling (#106).
 */
export function bundleContentSha256(primitives, model) {
  const manifest = model.manifest;
  const paths = ['bundle.json'];
  for (const id of manifest.stages) paths.push(`stages/${id}.json`);
  for (const id of manifest.roles ?? []) paths.push(`roles/${id}.md`);
  for (const id of manifest.tasks) paths.push(`tasks/${id}.md`);
  for (const id of manifest.skills ?? []) paths.push(`skills/${id}/SKILL.md`);
  for (const path of model.declared.knowledgeBase ?? []) paths.push(path);
  for (const id of model.declared.checklists ?? []) paths.push(checklistPath(id));
  if (model.assetDeclaration?.hooks.declared === true) paths.push(HOOKS_PATH);
  if (model.assetDeclaration?.mcp.declared === true) paths.push(MCP_PATH);
  if (model.constitutionDeclaration?.declared) paths.push('constitution/CONSTITUTION.md');
  const unique = [...new Set(paths)].sort(compareCodePoints);
  const rows = unique.map((path) => `${path}\t${fileHash(primitives, model, path)}\n`).join('');
  return primitives.sha256(encoder.encode(rows));
}

function buildSteps(stageRecord) {
  return stageRecord.value.steps.map((step) => {
    const out = { id: step.id, name: step.name };
    if (step.role !== undefined) out.role = step.role;
    out.task = step.task;
    out.skills = sorted(step.skills ?? []);
    out.outputs = step.outputs === undefined ? [] : [...step.outputs];
    out.gates = (step.gates ?? []).map((gate) => {
      const item = { command: gate.command };
      if (gate.timeout !== undefined) item.timeout = gate.timeout;
      return item;
    });
    return out;
  });
}

function buildCompiledWorkflow(primitives, model) {
  const manifest = model.manifest;
  const stages = model.stages.map((record) => {
    const stage = { id: record.id, name: record.value.name };
    if (record.value.description !== undefined) stage.description = record.value.description;
    stage.steps = buildSteps(record);
    stage.source = { path: record.path, sha256: fileHash(primitives, model, record.path) };
    return stage;
  });

  const roles = {};
  for (const id of sorted(model.declared.roles)) {
    const record = model.roles.get(id);
    const fields = record.fields;
    const role = { description: fields.description };
    if (fields.title !== undefined) role.title = fields.title;
    if (fields.mode !== undefined) role.mode = fields.mode;
    if (fields.model !== undefined) role.model = fields.model;
    if (fields.effort !== undefined) role.effort = fields.effort;
    if (fields.tools !== undefined) role.tools = sorted(fields.tools);
    if (fields.tools_deny !== undefined) role.tools_deny = sorted(fields.tools_deny);
    if (fields.skills !== undefined) role.skills = sorted(fields.skills);
    role.placeholder = fields.placeholder === true;
    role.instructions = record.body;
    role.source = { path: record.path, sha256: fileHash(primitives, model, record.path) };
    roles[id] = role;
  }

  const tasks = {};
  for (const id of sorted(model.declared.tasks)) {
    const record = model.tasks.get(id);
    const task = {};
    if (record.fields?.title !== undefined) task.title = record.fields.title;
    if (record.fields?.description !== undefined) task.description = record.fields.description;
    task.body = record.body;
    task.source = { path: record.path, sha256: fileHash(primitives, model, record.path) };
    tasks[id] = task;
  }

  const skills = {};
  for (const id of sorted(model.declared.skills)) {
    const record = model.skills.get(id);
    skills[id] = {
      description: record.fields.description,
      placeholder: record.fields.placeholder === true,
      body: record.body,
      source: { path: record.path, sha256: fileHash(primitives, model, record.path) },
    };
  }

  const knowledgeBase = sorted(model.declared.knowledgeBase ?? []).map((path) => ({
    path,
    body: model.texts.get(path) ?? '',
    source: { path, sha256: fileHash(primitives, model, path) },
  }));

  const checklists = sorted(model.declared.checklists ?? []).map((id) => {
    const path = checklistPath(id);
    return {
      id,
      body: model.texts.get(path) ?? '',
      source: { path, sha256: fileHash(primitives, model, path) },
    };
  });

  const assetFile = (declaration, path) => {
    if (declaration?.declared !== true) return null;
    return {
      path,
      body: model.texts.get(path) ?? '',
      source: { path, sha256: fileHash(primitives, model, path) },
    };
  };
  const hooks = assetFile(model.assetDeclaration?.hooks, HOOKS_PATH);
  const mcp = assetFile(model.assetDeclaration?.mcp, MCP_PATH);

  const constitution = [];
  if (model.constitution !== null && model.constitution !== undefined) {
    const mount = model.constitution;
    constitution.push({
      scope: 'global',
      placeholder: mount.placeholder,
      body: mount.text,
      source: { path: mount.path, sha256: primitives.sha256(mount.bytes) },
    });
  }

  const compiledWorkflow = {
    schema: COMPILED_WORKFLOW_SCHEMA,
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    source: {
      bundle: {
        schema: COMPILED_WORKFLOW_BUNDLE_SCHEMA,
        id: manifest.id,
        version: manifest.version,
        contentSha256: bundleContentSha256(primitives, model),
      },
      manifest: { path: 'bundle.json', sha256: fileHash(primitives, model, 'bundle.json') },
    },
  };
  if (manifest.requires !== undefined) {
    compiledWorkflow.requires = {};
    if (manifest.requires.engine !== undefined) compiledWorkflow.requires.engine = manifest.requires.engine;
    if (manifest.requires.projections !== undefined) {
      compiledWorkflow.requires.projections = sorted(manifest.requires.projections);
    }
  }
  compiledWorkflow.stages = stages;
  compiledWorkflow.roles = roles;
  compiledWorkflow.tasks = tasks;
  compiledWorkflow.skills = skills;
  compiledWorkflow.knowledgeBase = knowledgeBase;
  compiledWorkflow.checklists = checklists;
  compiledWorkflow.hooks = hooks;
  compiledWorkflow.mcp = mcp;
  compiledWorkflow.constitution = constitution;
  return compiledWorkflow;
}

function cardinalityIssues(compiledWorkflow, model) {
  const issues = [];
  const add = (kind, declared, embedded) => {
    issues.push(makeDiagnostic({
      severity: SEVERITY.ERROR,
      code: 'COMPILED_WORKFLOW_CARDINALITY_MISMATCH',
      path: COMPILED_WORKFLOW_FILENAME,
      pointer: '',
      message: `compiled workflow ${kind} do not match the source bundle`,
      details: { kind, declared, embedded },
    }));
  };
  const stageIds = compiledWorkflow.stages.map((stage) => stage.id);
  if (stageIds.join('\u0000') !== model.declared.stages.join('\u0000')) {
    add('stages', model.declared.stages, stageIds);
  }
  const declaredSteps = model.stages.flatMap((record) => record.value.steps.map((step) => step.id));
  const embeddedSteps = compiledWorkflow.stages.flatMap((stage) => stage.steps.map((step) => step.id));
  if (declaredSteps.join('\u0000') !== embeddedSteps.join('\u0000')) {
    add('steps', declaredSteps, embeddedSteps);
  }
  for (const kind of ['roles', 'tasks', 'skills']) {
    const declared = sorted(model.declared[kind]);
    const embedded = sorted(Object.keys(compiledWorkflow[kind]));
    if (declared.join('\u0000') !== embedded.join('\u0000')) add(kind, declared, embedded);
  }
  const declaredConstitution = model.constitutionDeclaration?.declared ? 1 : 0;
  if (declaredConstitution !== compiledWorkflow.constitution.length) {
    add('constitution', declaredConstitution, compiledWorkflow.constitution.length);
  }
  const declaredKnowledgeBase = sorted(model.declared.knowledgeBase ?? []);
  const embeddedKnowledgeBase = compiledWorkflow.knowledgeBase.map((item) => item.path);
  if (declaredKnowledgeBase.join('\u0000') !== embeddedKnowledgeBase.join('\u0000')) {
    add('knowledgeBase', declaredKnowledgeBase, embeddedKnowledgeBase);
  }
  const declaredChecklists = sorted(model.declared.checklists ?? []);
  const embeddedChecklists = compiledWorkflow.checklists.map((item) => item.id);
  if (declaredChecklists.join('\u0000') !== embeddedChecklists.join('\u0000')) {
    add('checklists', declaredChecklists, embeddedChecklists);
  }
  for (const kind of ['hooks', 'mcp']) {
    const declared = model.assetDeclaration?.[kind]?.declared === true ? 1 : 0;
    const embedded = compiledWorkflow[kind] === null ? 0 : 1;
    if (declared !== embedded) add(kind, declared, embedded);
  }
  return issues;
}

/**
 * Compile a bundle zip.
 *
 * @param {Uint8Array} input
 * @param {{ inflateRaw?: Function, sha256: Function }} primitives
 * @param {{ path?: string }} [options]
 * @returns {{ ok: boolean, compiledWorkflowBytes: Uint8Array|null, report: object, digest: string|null, compiledWorkflowReport?: object }}
 */
export function compileBundle(input, primitives = {}, options = {}) {
  if (typeof primitives.sha256 !== 'function') {
    throw new TypeError('compileBundle requires a sha256 primitive');
  }
  const { report, model } = analyzeBundle(input, primitives, options);
  if (!report.ok) {
    return { ok: false, compiledWorkflowBytes: null, report, digest: null };
  }

  const compiledWorkflow = buildCompiledWorkflow(primitives, model);
  const compiledWorkflowBytes = encoder.encode(serializeCompiledWorkflow(compiledWorkflow));
  const digest = primitives.sha256(compiledWorkflowBytes);
  const compiledWorkflowReport = validateCompiledWorkflow(compiledWorkflowBytes, primitives);

  const issues = cardinalityIssues(compiledWorkflow, model);
  if (issues.length > 0) {
    const failure = buildReport({
      target: 'compiled-workflow',
      schema: COMPILED_WORKFLOW_SCHEMA,
      artifact: { path: COMPILED_WORKFLOW_FILENAME, bytes: compiledWorkflowBytes.length, sha256: digest },
      id: compiledWorkflow.id,
      version: compiledWorkflow.version,
      counts: compiledWorkflowReport.counts,
      errors: issues,
      warnings: [],
    });
    return { ok: false, compiledWorkflowBytes: null, report: failure, digest: null, compiledWorkflowReport: failure };
  }
  if (!compiledWorkflowReport.ok) {
    return { ok: false, compiledWorkflowBytes: null, report: compiledWorkflowReport, digest: null, compiledWorkflowReport };
  }
  return { ok: true, compiledWorkflowBytes, report, digest, compiledWorkflowReport };
}
