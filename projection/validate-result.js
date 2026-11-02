/**
 * V1–V12 result validation (#69 §12.2, #82 §2/§5/§8).
 *
 * Every consumer (CLI, web, installer) runs this before using a result. The
 * checks are the contract: a result that fails any of them is untrustworthy
 * and must not be installed (`PROJECTION_RESULT_INVALID`).
 */
import { canonicalJson } from '../core/canonical-json.js';
import { compareCodePoints } from '../core/code-point.js';
import { makeDiagnostic, SEVERITY } from '../core/diagnostics.js';
import {
  MAX_PROJECTION_DEPTH,
  MAX_PROJECTION_PATH_BYTES,
  foldCase,
  hasFileDirPrefixConflict,
  utf8Length,
} from '../core/paths.js';
import { constitutionState } from '../runtime/shared/constitution.js';
import { CAPABILITIES, ID_PATTERN as ID_RE, LEVEL_RANK, SEMANTIC_CAPABILITIES } from './contract.js';
import { RESULT_FIELDS as TOP_LEVEL_ORDER } from './result-fields.js';

const RESULT_SCHEMA = 'r2c.projection-result/v1';
const INSTALL_PLAN_SCHEMA = 'r2c.install-plan/v1';
const OPTIONS_SCHEMA = 'r2c.projection-options/v1';
const SEMANTIC = new Set(SEMANTIC_CAPABILITIES);
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
const CODE_RE = /^[A-Z][A-Z0-9_]{2,63}$/;
const MAX_FILES = 4096;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const encoder = new TextEncoder();

function resolvePointer(ir, pointer) {
  if (pointer === '') return ir;
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) return undefined;
  const parts = pointer.slice(1).split('/').map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
  let node = ir;
  for (const part of parts) {
    if (node === null || node === undefined) return undefined;
    if (Array.isArray(node)) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(part)) return undefined;
      const index = Number(part);
      if (index >= node.length) return undefined;
      node = node[index];
    } else if (typeof node === 'object') {
      if (!Object.hasOwn(node, part)) return undefined;
      node = node[part];
    } else {
      return undefined;
    }
  }
  return node;
}

function pathIssues(path, writeRoots) {
  const issues = [];
  if (typeof path !== 'string' || path === '') return ['missing path'];
  if (path.startsWith('/') || path.includes('\\') || path.includes(':') || path.includes('\0')) issues.push('illegal path');
  const segments = path.split('/');
  if (segments.length > MAX_PROJECTION_DEPTH) issues.push('depth > 8');
  if (utf8Length(path) > MAX_PROJECTION_PATH_BYTES) issues.push('path > 200 bytes');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') issues.push('empty or dot segment');
    else if (!SEGMENT_RE.test(segment) || segment.endsWith('.') || segment.endsWith(' ')) issues.push(`bad segment ${segment}`);
  }
  if (segments.includes('.git')) issues.push('.git path');
  const last = segments[segments.length - 1];
  if (last === 'workflow.ir.json' || last === 'bundle.json') issues.push('reserved filename');
  if (!Array.isArray(writeRoots) || writeRoots.length === 0) issues.push('manifest has no writeRoots');
  else if (!writeRoots.some((root) => path === root || path.startsWith(`${root}/`))) issues.push('outside writeRoots');
  return issues;
}

function declaredLevel(manifest, target, capability) {
  const entry = manifest?.targets?.find((item) => item.id === target);
  const value = entry?.capabilities?.[capability];
  return typeof value === 'object' && value !== null ? value.level : value;
}

/**
 * Skill ids the option selection excludes. A capability that is worse than
 * the manifest level is legitimate only when the worst use point is one of
 * these (a selection loss, not a projection defect).
 */
function excludedSkillIds(ir, options) {
  const selected = Array.isArray(options?.skills) ? new Set(options.skills) : null;
  if (selected === null) return new Set();
  return new Set(Object.keys(ir?.skills ?? {}).filter((id) => !selected.has(id)));
}

/** True when a degradation pointer lands on a skill the options excluded. */
function pointsAtExcludedSkill(ir, pointer, excluded) {
  if (excluded.size === 0 || typeof pointer !== 'string' || !pointer.startsWith('/')) return false;
  const parts = pointer.slice(1).split('/').map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index] !== 'skills' || parts[index + 1] === undefined) continue;
    const resolved = resolvePointer(ir, `/${parts.slice(0, index + 2).join('/')}`);
    const id = typeof resolved === 'string' ? resolved : parts[index + 1];
    if (excluded.has(id)) return true;
  }
  return false;
}

function expectedTargets(manifest, options) {
  const ids = (manifest?.targets ?? []).map((target) => target.id);
  const selected = options?.targets;
  return Array.isArray(selected) ? ids.filter((id) => selected.includes(id)) : ids;
}

/**
 * Validate a result against the input it claims to describe.
 * Returns `{ok, diagnostics}`; diagnostics all carry
 * `code: PROJECTION_RESULT_INVALID` and `details.check` (`V1`…`V12`).
 */
export function validateResult(result, input) {
  const { ir, irDigest, manifest } = input ?? {};
  const options = input?.options ?? result?.options;
  const environment = input?.environment ?? { engineVersion: null };
  const assets = input?.assets ?? {};
  const diagnostics = [];
  const fail = (check, message, pointer = null) => {
    diagnostics.push(makeDiagnostic({
      severity: SEVERITY.ERROR,
      code: 'PROJECTION_RESULT_INVALID',
      pointer,
      message: `${check}: ${message}`,
      details: { check },
    }));
  };
  const finish = () => ({ ok: diagnostics.length === 0, diagnostics });
  if (result === null || typeof result !== 'object') {
    fail('V1', 'result is not an object');
    return finish();
  }

  // V1 ---------------------------------------------------------------------
  if (result.schema !== RESULT_SCHEMA || result.ok !== true) fail('V1', 'schema/ok');
  if (result.projection?.id !== manifest?.id || result.projection?.version !== manifest?.version) {
    fail('V1', 'projection reference does not match the manifest');
  }
  if (result.ir?.id !== ir?.id
    || result.ir?.version !== ir?.version
    || result.ir?.digest !== irDigest
    || result.ir?.contentSha256 !== ir?.source?.bundle?.contentSha256) {
    fail('V1', 'ir reference does not match the input IR');
  }

  // V2 ---------------------------------------------------------------------
  if (options === undefined || options === null) {
    fail('V2', 'missing normalized options');
  } else {
    const echoed = result.options;
    const fields = ['schema', 'projection', 'ir', 'stageOrder', 'skills', 'targets', 'extra'];
    for (const field of fields) {
      if (JSON.stringify(echoed?.[field]) !== JSON.stringify(options[field])) fail('V2', `options.${field} does not echo the resolved input`);
    }
    for (const field of ['stageOrder', 'skills', 'targets']) {
      if (!Array.isArray(echoed?.[field])) fail('V2', `options.${field} must be a resolved array`);
    }
    if (echoed?.schema !== OPTIONS_SCHEMA) fail('V2', `options.schema must be ${OPTIONS_SCHEMA}`);
    const expectedEnvironment = { engineVersion: environment?.engineVersion ?? null };
    if (JSON.stringify(result.environment) !== JSON.stringify(expectedEnvironment)) {
      fail('V2', 'environment does not echo the input');
    }
  }

  // V3 ---------------------------------------------------------------------
  const targets = expectedTargets(manifest, options);
  if (JSON.stringify(result.targets) !== JSON.stringify(targets)) fail('V3', 'targets are not the resolved option targets');
  const files = Array.isArray(result.files) ? result.files : [];
  if (!Array.isArray(result.files)) fail('V5', 'files is not an array');
  for (const target of Array.isArray(result.targets) ? result.targets : []) {
    if (!files.some((file) => Array.isArray(file.targets) && file.targets.includes(target))) {
      fail('V3', `target ${target} produced no file`);
    }
  }

  // V4 ---------------------------------------------------------------------
  const stageOrder = Array.isArray(options?.stageOrder) ? options.stageOrder : (ir?.stages ?? []).map((stage) => stage.id);
  const expectedStages = stageOrder;
  const byId = new Map((ir?.stages ?? []).map((stage) => [stage.id, stage]));
  const expectedSteps = stageOrder.flatMap((id) => (byId.get(id)?.steps ?? []).map((step) => step.id));
  const coverageStages = result.coverage?.stages;
  const coverageSteps = result.coverage?.steps;
  if (JSON.stringify(coverageStages) !== JSON.stringify(expectedStages)) fail('V4', 'coverage.stages is not the applied stage order');
  else if (JSON.stringify(coverageSteps) !== JSON.stringify(expectedSteps)) fail('V4', 'coverage.steps is not the applied step order');
  else {
    const all = (ir?.stages ?? []).flatMap((stage) => stage.steps.map((step) => step.id));
    if (new Set(coverageSteps).size !== all.length) fail('V4', 'coverage.steps does not cover every step exactly once');
  }

  // V5 ---------------------------------------------------------------------
  const folded = new Set();
  const foldedPaths = [];
  for (const file of files) {
    for (const issue of pathIssues(file?.path, manifest?.writeRoots)) fail('V5', `${file?.path}: ${issue}`, file?.path ?? null);
    if (typeof file?.path === 'string') {
      const key = foldCase(file.path);
      if (folded.has(key)) fail('V5', `duplicate path ${file.path}`, file.path);
      folded.add(key);
      foldedPaths.push(key);
    }
    if (!Array.isArray(file?.targets) || file.targets.length === 0
      || file.targets.some((target) => !(result.targets ?? []).includes(target))) {
      fail('V5', `${file?.path}: targets must be a non-empty subset of result.targets`, file?.path ?? null);
    }
    if (file?.content?.includes('\r') || (file?.content ?? '').startsWith('\uFEFF')) {
      fail('V6', `${file?.path}: content must be LF and BOM-free`, file?.path ?? null);
    }
  }
  for (const path of foldedPaths) {
    if (foldedPaths.some((other) => other !== path && hasFileDirPrefixConflict(path, other))) {
      fail('V5', `${path}: file/dir prefix conflict`);
      break;
    }
  }

  // V6 ---------------------------------------------------------------------
  for (const file of files) {
    if (typeof file?.content !== 'string' || !file.content.endsWith('\n')) {
      fail('V6', `${file?.path}: content must be non-empty text ending with a single LF`, file?.path ?? null);
    }
    if (file?.mode !== 0o644 && file?.mode !== 0o755) fail('V6', `${file?.path}: mode must be 0644 or 0755`, file?.path ?? null);
    if (file?.origin === 'asset') {
      if (typeof file.assetId !== 'string') fail('V6', `${file?.path}: asset origin needs assetId`);
      else if (assets[file.assetId] !== undefined && assets[file.assetId] !== file.content) {
        fail('V6', `${file?.path}: asset content differs from the declared asset`);
      }
    } else if (file?.origin !== 'generated') {
      fail('V6', `${file?.path}: origin must be generated or asset`);
    }
  }

  // V7 ---------------------------------------------------------------------
  const steps = Array.isArray(result.installPlan?.steps) ? result.installPlan.steps : [];
  if (result.installPlan?.schema !== INSTALL_PLAN_SCHEMA || result.installPlan?.root !== 'project') {
    fail('V7', 'install plan header');
  }
  if (steps.length !== files.length) fail('V7', 'install plan cardinality does not match files');
  const planPaths = steps.map((step) => step.path);
  if (new Set(planPaths.map((path) => foldCase(path))).size !== planPaths.length) fail('V7', 'install plan writes a path twice');
  for (const step of steps) {
    if (step?.op !== 'write' || (step?.overwrite !== 'replace' && step?.overwrite !== 'fail-if-exists')) {
      fail('V7', `${step?.path}: install step must be a whole-file write`);
    }
    if (!folded.has(foldCase(step?.path))) fail('V7', `${step?.path}: plan path has no file`);
  }
  for (const file of files) {
    if (!planPaths.some((path) => foldCase(path) === foldCase(file?.path))) fail('V7', `${file?.path}: file is not installed`);
  }

  // V8 ---------------------------------------------------------------------
  const report = Array.isArray(result.capabilityReport) ? result.capabilityReport : [];
  if (report.length !== (result.targets ?? []).length * CAPABILITIES.length) {
    fail('V8', `capabilityReport has ${report.length} rows, expected ${(result.targets ?? []).length * CAPABILITIES.length}`);
  } else {
    let index = 0;
    for (const target of result.targets) {
      for (const capability of CAPABILITIES) {
        const entry = report[index];
        index += 1;
        if (entry?.target !== target || entry?.capability !== capability) fail('V8', `capability row order at ${target}/${capability}`);
        const declared = declaredLevel(manifest, target, capability);
        if (LEVEL_RANK[declared] === undefined || LEVEL_RANK[entry?.level] === undefined
          || LEVEL_RANK[entry.level] < LEVEL_RANK[declared]) {
          fail('V8', `${target}/${capability} level ${entry?.level} is better than declared ${declared}`);
        } else if (LEVEL_RANK[entry.level] > LEVEL_RANK[declared]) {
          // Worse than declared is only legitimate when the worst use point is
          // a skill the options excluded (a selection loss); any other
          // over-degradation is a projection defect.
          const excluded = excludedSkillIds(ir, options);
          const explained = (result.degradations ?? []).some((record) => record.target === target
            && record.capability === capability
            && LEVEL_RANK[record.level] === LEVEL_RANK[entry.level]
            && pointsAtExcludedSkill(ir, record.pointer, excluded));
          if (!explained) {
            fail('V8', `${target}/${capability} level ${entry.level} is worse than declared ${declared} with no option exclusion`);
          }
        }
        if (!Array.isArray(entry?.uses)) fail('V8', `${target}/${capability} uses is not an array`);
        else {
          for (const use of entry.uses) {
            if (resolvePointer(ir, use) === undefined) fail('V8', `${target}/${capability}: use pointer ${use} does not resolve`);
          }
        }
      }
    }
  }

  // V9 ---------------------------------------------------------------------
  const degradations = Array.isArray(result.degradations) ? result.degradations : [];
  const keys = new Set();
  for (const record of degradations) {
    if (!CODE_RE.test(String(record?.code ?? ''))) fail('V9', `bad degradation code ${record?.code}`, record?.pointer ?? null);
    if (record?.level !== 'degraded' && record?.level !== 'unavailable') fail('V9', `${record?.code}: level must be degraded/unavailable`);
    if (typeof record?.reason !== 'string' || record.reason.length === 0 || record.reason.length > 500) fail('V9', `${record?.code}: reason must be 1..500 characters`);
    if (typeof record?.effect !== 'string' || record.effect.length === 0 || record.effect.length > 500) fail('V9', `${record?.code}: effect must be 1..500 characters`);
    if (record?.capability !== undefined && !CAPABILITIES.includes(record.capability)) fail('V9', `bad capability ${record?.capability}`);
    if (typeof record?.pointer !== 'string' || resolvePointer(ir, record.pointer) === undefined) {
      fail('V9', `pointer ${record?.pointer} does not resolve`, record?.pointer ?? null);
    }
    const key = [record?.target ?? '', record?.capability ?? '', record?.pointer ?? '', record?.field ?? ''].join('|');
    if (keys.has(key)) fail('V9', `duplicate degradation for ${key}`);
    keys.add(key);
  }
  for (const entry of report) {
    if (!SEMANTIC.has(entry?.capability)) continue;
    const declared = declaredLevel(manifest, entry.target, entry.capability);
    if (LEVEL_RANK[declared] < LEVEL_RANK.degraded) continue;
    for (const use of entry.uses ?? []) {
      const covered = degradations.some((record) => record.target === entry.target
        && record.capability === entry.capability
        && (record.pointer === use
          || record.pointer === ''
          || (record.field !== undefined && use.startsWith(`${record.pointer}/`))));
      if (!covered) fail('V9', `no degradation for use ${entry.target}/${entry.capability}${use}`);
    }
  }

  // V10 --------------------------------------------------------------------
  const expectedPlaceholders = {
    roles: Object.keys(ir?.roles ?? {}).filter((id) => ir.roles[id].placeholder).sort(compareCodePoints),
    skills: Object.keys(ir?.skills ?? {}).filter((id) => ir.skills[id].placeholder).sort(compareCodePoints),
    constitution: constitutionState(ir?.constitution ?? []),
  };
  if (JSON.stringify(result.metadata?.placeholders) !== JSON.stringify(expectedPlaceholders)) {
    fail('V10', 'metadata.placeholders does not equal the IR placeholder set');
  }
  for (const target of result.targets ?? []) {
    const map = result.metadata?.idMap?.[target];
    if (map === undefined) {
      fail('V10', `idMap is missing target ${target}`);
      continue;
    }
    for (const kind of ['stages', 'steps', 'roles', 'skills']) {
      const entries = map[kind];
      if (entries === null || typeof entries !== 'object') {
        fail('V10', `idMap.${target}.${kind} is not an object`);
        continue;
      }
      const values = Object.values(entries);
      if (new Set(values).size !== values.length) fail('V10', `idMap ${target}/${kind} is not injective`);
      for (const value of values) {
        if (typeof value !== 'string' || value === '') fail('V10', `idMap ${target}/${kind} has an empty value`);
      }
      for (const key of Object.keys(entries)) {
        if (kind === 'stages' && !(ir?.stages ?? []).some((stage) => stage.id === key)) fail('V10', `idMap source stage ${key} is absent`);
        if (kind === 'steps' && !(ir?.stages ?? []).some((stage) => stage.steps.some((step) => step.id === key))) fail('V10', `idMap source step ${key} is absent`);
        if (kind === 'roles' && ir?.roles?.[key] === undefined) fail('V10', `idMap source role ${key} is absent`);
        if (kind === 'skills' && ir?.skills?.[key] === undefined) fail('V10', `idMap source skill ${key} is absent`);
      }
    }
  }
  const artifacts = result.metadata?.artifacts;
  if (artifacts === null || typeof artifacts !== 'object') fail('V10', 'metadata.artifacts is not an object');
  else {
    for (const [name, path] of Object.entries(artifacts)) {
      if (!ID_RE.test(name)) fail('V10', `artifact key ${name} is not a kebab id`);
      if (!folded.has(foldCase(path))) fail('V10', `artifact ${name} points at a missing file`);
    }
  }

  // V11 --------------------------------------------------------------------
  let totalBytes = 0;
  for (const file of files) {
    if (typeof file?.content === 'string' && file.content.includes('{{submit}}')) {
      fail('V11', `${file?.path}: {{submit}} residue`, file?.path ?? null);
    }
    const bytes = typeof file?.content === 'string' ? encoder.encode(file.content).length : 0;
    if (bytes > MAX_FILE_BYTES) fail('V11', `${file?.path}: file > 4 MiB`, file?.path ?? null);
    totalBytes += bytes;
  }
  if (files.length > MAX_FILES || totalBytes > MAX_TOTAL_BYTES) fail('V11', 'output exceeds the file/byte limits');

  // V12 --------------------------------------------------------------------
  if (JSON.stringify(Object.keys(result)) !== JSON.stringify(TOP_LEVEL_ORDER)) {
    fail('V12', `top-level key order is ${Object.keys(result).join(',')}`);
  }
  try {
    if (JSON.stringify(JSON.parse(canonicalJson(result))) !== JSON.stringify(result)) {
      fail('V12', 'result is not JSON-serializable without loss');
    }
  } catch {
    fail('V12', 'result is not JSON-serializable');
  }

  return finish();
}
