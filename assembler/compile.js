/**
 * Bundle -> canonical IR compiler (spec §5, decision #68).
 *
 * The fixed 11 steps and where they run:
 *   1 validate                 analyzeBundle (errors gate, nothing produced)
 *   2 parse manifest           analyzeBundle -> model.manifest
 *   3 freeze declarations      analyzeBundle -> model.declared
 *   4 per-file SHA-256         fileHash()
 *   5 contentSha256            contentSha256()
 *   6 parse stages/steps       analyzeBundle -> model.stages (author order)
 *   7 assets into maps         buildIr() (roles/tasks/skills sorted by id)
 *   8 re-check references      analyzeBundle crossrefs + validateIr self-check
 *   9 assemble in schema order buildIr()
 *  10 canonical serialization  serializeIr()
 *  11 self-check               validateIr() + cardinalityIssues()
 *
 * The compiler never re-implements validation and never emits a partial
 * artifact: any error yields `irBytes: null`.
 */
import { compareCodePoints } from '../core/code-point.js';
import { buildReport, makeDiagnostic, SEVERITY } from '../core/diagnostics.js';
import {
  IR_BUNDLE_SCHEMA,
  IR_FILENAME,
  IR_SCHEMA,
} from '../ir/schema.js';
import { serializeIr } from '../ir/serialize.js';
import { analyzeBundle } from './validate-bundle.js';
import { validateIr } from './validate-ir.js';
import { sorted } from '../core/sort.js';

const encoder = new TextEncoder();

function fileHash(primitives, model, path) {
  return primitives.sha256(model.entries.get(path).data);
}

/**
 * `contentSha256` of a bundle model (step 5): the digest of the declared
 * member hashes. Exported so an installer can re-derive the zip ↔ IR binding
 * without compiling (#106).
 */
export function bundleContentSha256(primitives, model) {
  const manifest = model.manifest;
  const paths = ['bundle.json'];
  for (const id of manifest.stages) paths.push(`stages/${id}.json`);
  for (const id of manifest.roles ?? []) paths.push(`roles/${id}.md`);
  for (const id of manifest.tasks) paths.push(`tasks/${id}.md`);
  for (const id of manifest.skills ?? []) paths.push(`skills/${id}/SKILL.md`);
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

function buildIr(primitives, model) {
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

  const ir = {
    schema: IR_SCHEMA,
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    source: {
      bundle: {
        schema: IR_BUNDLE_SCHEMA,
        id: manifest.id,
        version: manifest.version,
        contentSha256: bundleContentSha256(primitives, model),
      },
      manifest: { path: 'bundle.json', sha256: fileHash(primitives, model, 'bundle.json') },
    },
  };
  if (manifest.requires !== undefined) {
    ir.requires = {};
    if (manifest.requires.engine !== undefined) ir.requires.engine = manifest.requires.engine;
    if (manifest.requires.projections !== undefined) {
      ir.requires.projections = sorted(manifest.requires.projections);
    }
  }
  ir.stages = stages;
  ir.roles = roles;
  ir.tasks = tasks;
  ir.skills = skills;
  ir.constitution = constitution;
  return ir;
}

function cardinalityIssues(ir, model) {
  const issues = [];
  const add = (kind, declared, embedded) => {
    issues.push(makeDiagnostic({
      severity: SEVERITY.ERROR,
      code: 'IR_CARDINALITY_MISMATCH',
      path: IR_FILENAME,
      pointer: '',
      message: `IR ${kind} do not match the source bundle`,
      details: { kind, declared, embedded },
    }));
  };
  const stageIds = ir.stages.map((stage) => stage.id);
  if (stageIds.join('\u0000') !== model.declared.stages.join('\u0000')) {
    add('stages', model.declared.stages, stageIds);
  }
  const declaredSteps = model.stages.flatMap((record) => record.value.steps.map((step) => step.id));
  const embeddedSteps = ir.stages.flatMap((stage) => stage.steps.map((step) => step.id));
  if (declaredSteps.join('\u0000') !== embeddedSteps.join('\u0000')) {
    add('steps', declaredSteps, embeddedSteps);
  }
  for (const kind of ['roles', 'tasks', 'skills']) {
    const declared = sorted(model.declared[kind]);
    const embedded = sorted(Object.keys(ir[kind]));
    if (declared.join('\u0000') !== embedded.join('\u0000')) add(kind, declared, embedded);
  }
  const declaredConstitution = model.constitutionDeclaration?.declared ? 1 : 0;
  if (declaredConstitution !== ir.constitution.length) {
    add('constitution', declaredConstitution, ir.constitution.length);
  }
  return issues;
}

/**
 * Compile a bundle zip.
 *
 * @param {Uint8Array} input
 * @param {{ inflateRaw?: Function, sha256: Function }} primitives
 * @param {{ path?: string }} [options]
 * @returns {{ ok: boolean, irBytes: Uint8Array|null, report: object, digest: string|null, irReport?: object }}
 */
export function compileBundle(input, primitives = {}, options = {}) {
  if (typeof primitives.sha256 !== 'function') {
    throw new TypeError('compileBundle requires a sha256 primitive');
  }
  const { report, model } = analyzeBundle(input, primitives, options);
  if (!report.ok) {
    return { ok: false, irBytes: null, report, digest: null };
  }

  const ir = buildIr(primitives, model);
  const irBytes = encoder.encode(serializeIr(ir));
  const digest = primitives.sha256(irBytes);
  const irReport = validateIr(irBytes, primitives);

  const issues = cardinalityIssues(ir, model);
  if (issues.length > 0) {
    const failure = buildReport({
      target: 'ir',
      schema: IR_SCHEMA,
      artifact: { path: IR_FILENAME, bytes: irBytes.length, sha256: digest },
      id: ir.id,
      version: ir.version,
      counts: irReport.counts,
      errors: issues,
      warnings: [],
    });
    return { ok: false, irBytes: null, report: failure, digest: null, irReport: failure };
  }
  if (!irReport.ok) {
    return { ok: false, irBytes: null, report: irReport, digest: null, irReport };
  }
  return { ok: true, irBytes, report, digest, irReport };
}
