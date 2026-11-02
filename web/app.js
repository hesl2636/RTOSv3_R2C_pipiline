/**
 * Read-only local surface (ticket #108).
 *
 * The browser runs the same shared assembler (`validateBundleAsync`) on the
 * uploaded bytes and compares its Report with the server's authoritative
 * Report. It never edits the bundle or the IR; the download uses the server's
 * bytes. All bundle-derived strings are written with `textContent`/DOM nodes.
 */
import { validateBundleAsync } from '../assembler/validate-bundle.js';
import { LIMITS } from '../assembler/limits.js';
import { canonicalJson } from '../core/canonical-json.js';
import { isCanonicalOptions, normalizeOptions } from '../projection/options.js';
import { project } from '../projection/project.js';
import { allowedProjections, defaultTargets, getProjection } from '../projection/registry.js';
import { validateResult } from '../projection/validate-result.js';
import {
  inflateRaw,
  missingRequirements,
  probeBrowserFloor,
  sha256Hex,
} from './primitives-browser.js';
import { loadSharedModules } from './shared-imports.js';
import webManifest from './web-manifest.json' with { type: 'json' };

const state = {
  csrf: null,
  limits: null,
  floor: null,
  degraded: false,
  mismatch: false,
  irBytes: null,
  ir: null,
  uploadId: null,
  allowed: [],
  options: {},
  previews: {},
  build: null,
  report: null,
  diagnostics: [],
  shared: null,
  engineVersion: null,
};

function byId(id) {
  return document.getElementById(id);
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function clear(node) {
  while (node.firstChild !== null) node.removeChild(node.firstChild);
}

function show(node, visible) {
  if (node !== null) node.hidden = !visible;
}

function setStatus(text) {
  const status = byId('upload-status');
  if (status !== null) status.textContent = text;
}

function showFallback(reasons) {
  window.__R2C_BOOT_REASONS__ = reasons;
  if (typeof window.__r2cShowFallback === 'function') window.__r2cShowFallback(reasons);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'unknown';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function locationOf(diagnostic) {
  if (diagnostic.path === '' || diagnostic.path === null) return diagnostic.pointer ?? '(archive)';
  if (diagnostic.line !== null && diagnostic.line !== undefined) return `${diagnostic.path}:${diagnostic.line}`;
  if (diagnostic.pointer !== null && diagnostic.pointer !== undefined && diagnostic.pointer !== '') {
    return `${diagnostic.path}${diagnostic.pointer}`;
  }
  return diagnostic.path;
}

function displayName(id) {
  return id === null || id === undefined ? '—' : String(id);
}

function appendKeyValue(parent, label, value) {
  const row = element('div', 'summary-item');
  row.append(element('span', 'hint', `${label}: `), element('span', 'mono', displayName(value)));
  parent.append(row);
}

/* -------------------------------------------------------------------------- */
/* Report                                                                     */
/* -------------------------------------------------------------------------- */

function renderSummary(report) {
  const summary = byId('report-summary');
  clear(summary);
  appendKeyValue(summary, 'ok', report.ok ? 'true' : 'false');
  appendKeyValue(summary, 'id', report.id);
  appendKeyValue(summary, 'version', report.version);
  appendKeyValue(summary, 'schema', report.schema);
  appendKeyValue(summary, 'artifact', report.artifact?.path);
  appendKeyValue(summary, 'bytes', formatBytes(report.artifact?.bytes));
  appendKeyValue(summary, 'sha256', report.artifact?.sha256);
  const counts = report.counts ?? {};
  for (const key of ['stages', 'steps', 'roles', 'tasks', 'skills', 'constitutions']) {
    appendKeyValue(summary, key, counts[key] ?? 0);
  }
  appendKeyValue(summary, 'errors', counts.errors ?? 0);
  appendKeyValue(summary, 'warnings', counts.warnings ?? 0);
  show(summary, true);
  show(byId('report-body'), true);
}

function filteredDiagnostics() {
  const severity = byId('severity-filter')?.value ?? 'all';
  const prefix = (byId('path-filter')?.value ?? '').trim();
  return state.diagnostics.filter((diagnostic) => {
    if (severity !== 'all' && diagnostic.severity !== severity) return false;
    if (prefix !== '' && !String(diagnostic.path ?? '').startsWith(prefix)) return false;
    return true;
  });
}

function renderDiagnostics() {
  const list = byId('diagnostics');
  clear(list);
  const diagnostics = filteredDiagnostics();
  for (const diagnostic of diagnostics) {
    const item = element('li');
    item.append(
      element('span', `severity-${diagnostic.severity}`, diagnostic.severity),
      element('span', 'mono', diagnostic.code),
      element('span', 'location', locationOf(diagnostic)),
    );
    const message = element('span', 'message', diagnostic.message);
    if (diagnostic.details !== undefined) {
      message.classList.add('has-details');
      message.title = JSON.stringify(diagnostic.details);
    }
    item.append(message);
    list.append(item);
  }
  show(byId('diagnostics-empty'), diagnostics.length === 0);
}

function renderReport(report) {
  state.report = report;
  state.diagnostics = [...(report.errors ?? []), ...(report.warnings ?? [])];
  renderSummary(report);
  renderDiagnostics();
}

/* -------------------------------------------------------------------------- */
/* IR                                                                         */
/* -------------------------------------------------------------------------- */

function decodeBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function labelValue(parent, label, value) {
  parent.append(element('span', 'hint', label), element('span', null, String(value)));
}

function constitutionState(ir) {
  const mounts = Array.isArray(ir.constitution) ? ir.constitution : [];
  if (typeof state.shared?.constitutionState === 'function') {
    return state.shared.constitutionState(mounts);
  }
  if (mounts.length === 0) return 'absent';
  return mounts.some((mount) => mount.placeholder === true) ? 'placeholder' : 'present';
}

function renderStages(ir) {
  const list = byId('ir-stages');
  clear(list);
  for (const stage of ir.stages ?? []) {
    const item = element('li');
    const head = element('div');
    head.append(element('strong', null, stage.name ?? stage.id), element('span', 'mono', ` ${stage.id}`));
    item.append(head);
    if (stage.description) item.append(element('p', 'hint', stage.description));
    const source = sourceLine(stage.source);
    if (source !== '') item.append(element('p', 'mono hint', source));
    const steps = element('ul', 'step-list');
    for (const step of stage.steps ?? []) {
      const row = element('li');
      row.append(element('span', 'mono', step.id), document.createTextNode(` — ${step.name ?? step.id}`));
      const details = [];
      if (step.role !== undefined) details.push(`role ${step.role}`);
      if (step.task !== undefined) details.push(`task ${step.task}`);
      if (Array.isArray(step.skills) && step.skills.length > 0) details.push(`skills ${step.skills.join(', ')}`);
      if (Array.isArray(step.gates) && step.gates.length > 0) details.push(`gates ${step.gates.length}`);
      if (Array.isArray(step.outputs) && step.outputs.length > 0) details.push(`outputs ${step.outputs.join(', ')}`);
      if (details.length > 0) row.append(element('span', 'hint', ` (${details.join('; ')})`));
      steps.append(row);
    }
    item.append(steps);
    list.append(item);
  }
}

function sourceLine(source) {
  if (!source || typeof source !== 'object') return '';
  const parts = [];
  if (source.path !== undefined) parts.push(source.path);
  if (source.sha256 !== undefined) parts.push(`sha256 ${source.sha256}`);
  return parts.join(' · ');
}

function renderRoles(ir) {
  const list = byId('ir-roles');
  clear(list);
  for (const [id, role] of Object.entries(ir.roles ?? {})) {
    const item = element('li');
    item.append(element('strong', null, id));
    if (role.placeholder === true) item.append(element('span', 'badge badge-warn', 'placeholder'));
    item.append(element('p', null, role.description ?? ''));
    if (Array.isArray(role.skills) && role.skills.length > 0) {
      item.append(element('p', 'hint', `preloads: ${role.skills.join(', ')}`));
    }
    const source = sourceLine(role.source);
    if (source !== '') item.append(element('p', 'mono hint', source));
    const body = element('details');
    body.append(element('summary', null, 'instructions (read-only)'), element('pre', 'raw', role.instructions ?? ''));
    item.append(body);
    list.append(item);
  }
}

function renderTasks(ir) {
  const list = byId('ir-tasks');
  clear(list);
  for (const [id, task] of Object.entries(ir.tasks ?? {})) {
    const item = element('li');
    item.append(element('strong', null, id));
    if (task.title) item.append(document.createTextNode(` — ${task.title}`));
    if (task.description) item.append(element('p', null, task.description));
    const source = sourceLine(task.source);
    if (source !== '') item.append(element('p', 'mono hint', source));
    const body = element('details');
    body.append(element('summary', null, 'body (read-only)'), element('pre', 'raw', task.body ?? ''));
    item.append(body);
    list.append(item);
  }
}

function renderSkills(ir) {
  const list = byId('ir-skills');
  clear(list);
  for (const [id, skill] of Object.entries(ir.skills ?? {})) {
    const item = element('li');
    item.append(element('strong', null, id));
    if (skill.placeholder === true) item.append(element('span', 'badge badge-warn', 'placeholder'));
    item.append(element('p', null, skill.description ?? ''));
    const source = sourceLine(skill.source);
    if (source !== '') item.append(element('p', 'mono hint', source));
    list.append(item);
  }
}

function renderIr(data) {
  const irBytes = decodeBase64(data.ir.data);
  state.irBytes = irBytes;
  const text = new TextDecoder('utf-8', { fatal: true }).decode(irBytes);
  const ir = JSON.parse(text);
  state.ir = { json: ir, digest: data.ir.digest, id: ir.id, version: ir.version };
  state.allowed = allowedProjections(ir);

  const identity = byId('ir-identity');
  clear(identity);
  appendKeyValue(identity, 'id', ir.id);
  appendKeyValue(identity, 'name', ir.name);
  appendKeyValue(identity, 'version', ir.version);
  appendKeyValue(identity, 'digest', data.ir.digest);
  appendKeyValue(identity, 'bytes', formatBytes(irBytes.length));
  appendKeyValue(identity, 'contentSha256', ir.source?.bundle?.contentSha256);
  appendKeyValue(identity, 'manifest sha256', ir.source?.manifest?.sha256);
  appendKeyValue(identity, 'requires', JSON.stringify(ir.requires ?? {}));

  renderStages(ir);
  renderRoles(ir);
  renderTasks(ir);
  renderSkills(ir);

  const constitution = byId('ir-constitution');
  clear(constitution);
  const mounts = Array.isArray(ir.constitution) ? ir.constitution : [];
  const constitutionName = constitutionState(ir);
  constitution.append(element('p', `status constitution-${constitutionName}`, `state: ${constitutionName} (${mounts.length} mount(s))`));
  for (const mount of mounts) {
    const item = element('div', 'entity');
    item.append(element('strong', null, `${mount.scope ?? 'global'}${mount.placeholder === true ? ' · placeholder' : ''}`));
    const source = sourceLine(mount.source);
    if (source !== '') item.append(element('p', 'mono hint', source));
    const body = element('details');
    body.append(element('summary', null, 'body (read-only)'), element('pre', 'raw', mount.body ?? ''));
    item.append(body);
    constitution.append(item);
  }

  byId('ir-digest').textContent = `sha256 ${data.ir.digest}`;
  byId('ir-raw').textContent = text;
  show(byId('ir-empty'), false);
  show(byId('ir-body'), true);
}

function renderNoIr() {
  state.irBytes = null;
  state.ir = null;
  state.uploadId = null;
  state.allowed = [];
  state.options = {};
  state.previews = {};
  state.build = null;
  renderOptions();
  const buildBody = byId('build-body');
  if (buildBody !== null) show(buildBody, false);
  show(byId('ir-body'), false);
  show(byId('ir-empty'), true);
  byId('ir-empty').textContent = 'No IR: the bundle must validate without errors before it compiles.';
}

function downloadIr() {
  if (state.irBytes === null) return;
  const blob = new Blob([state.irBytes], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'workflow.ir.json';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/* -------------------------------------------------------------------------- */
/* Projection options                                                         */
/* -------------------------------------------------------------------------- */

const PREVIEW_DEBOUNCE_MS = 150;
let previewTimer = null;

function stageIdsOf(ir) {
  return (ir.stages ?? []).map((stage) => stage.id);
}

function skillIdsOf(ir) {
  return Object.keys(ir.skills ?? {}).sort();
}

function defaultOptionsFor(ir) {
  const defaults = {};
  for (const id of state.allowed) {
    defaults[id] = {
      stageOrder: stageIdsOf(ir),
      skills: skillIdsOf(ir),
      targets: defaultTargets(id),
    };
  }
  return defaults;
}

function optionsForRequest() {
  const options = {};
  for (const id of state.allowed) {
    const current = state.options[id];
    options[id] = {
      stageOrder: [...current.stageOrder],
      skills: [...current.skills],
      targets: [...current.targets],
      extra: {},
    };
  }
  return options;
}

function schedulePreview() {
  if (previewTimer !== null) clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    previewTimer = null;
    void preview();
  }, PREVIEW_DEBOUNCE_MS);
}

function resetOptions(message) {
  state.options = state.ir === null ? {} : defaultOptionsFor(state.ir.json);
  state.previews = {};
  renderOptions();
  const status = byId('options-status');
  if (status !== null) status.textContent = message ?? 'Options reset to the published defaults.';
  schedulePreview();
}

function renderStageOrder(list, projectionId) {
  clear(list);
  const current = state.options[projectionId];
  const stages = new Map((state.ir?.json.stages ?? []).map((stage) => [stage.id, stage]));
  current.stageOrder.forEach((id, index) => {
    const item = element('li');
    item.append(element('strong', null, stages.get(id)?.name ?? id), element('span', 'mono hint', ` ${id}`));
    const up = element('button', null, '↑');
    up.type = 'button';
    up.title = 'move up';
    up.disabled = index === 0;
    up.addEventListener('click', () => {
      const order = current.stageOrder;
      [order[index - 1], order[index]] = [order[index], order[index - 1]];
      renderStageOrder(list, projectionId);
      schedulePreview();
    });
    const down = element('button', null, '↓');
    down.type = 'button';
    down.title = 'move down';
    down.disabled = index === current.stageOrder.length - 1;
    down.addEventListener('click', () => {
      const order = current.stageOrder;
      [order[index + 1], order[index]] = [order[index], order[index + 1]];
      renderStageOrder(list, projectionId);
      schedulePreview();
    });
    item.append(up, down);
    list.append(item);
  });
}

function renderSkillPicker(container, projectionId) {
  clear(container);
  const current = state.options[projectionId];
  const search = element('input');
  search.type = 'text';
  search.placeholder = 'filter skills';
  search.setAttribute('spellcheck', 'false');
  const all = element('button', null, 'all');
  const none = element('button', null, 'none');
  const invert = element('button', null, 'invert');
  for (const button of [all, none, invert]) button.type = 'button';
  const list = element('ul', 'check-list');
  const rows = [];
  for (const [id, skill] of Object.entries(state.ir?.json.skills ?? {})) {
    const label = element('label', 'check-row');
    const box = element('input');
    box.type = 'checkbox';
    box.checked = current.skills.includes(id);
    box.addEventListener('change', () => {
      const selected = new Set(current.skills);
      if (box.checked) selected.add(id);
      else selected.delete(id);
      current.skills = [...selected].sort();
      schedulePreview();
    });
    label.append(box, element('span', 'mono', id));
    if (skill.placeholder === true) label.append(element('span', 'badge badge-warn', 'placeholder'));
    rows.push({ label, id });
    list.append(label);
  }
  const applyFilter = () => {
    const query = search.value.trim().toLowerCase();
    for (const row of rows) row.label.hidden = query !== '' && !row.id.toLowerCase().includes(query);
  };
  const setAll = (predicate) => {
    for (const row of rows) {
      const box = row.label.querySelector('input');
      box.checked = predicate(row.id);
    }
    current.skills = rows.filter((row) => predicate(row.id)).map((row) => row.id).sort();
    schedulePreview();
  };
  search.addEventListener('input', applyFilter);
  all.addEventListener('click', () => setAll(() => true));
  none.addEventListener('click', () => setAll(() => false));
  invert.addEventListener('click', () => setAll((id) => !current.skills.includes(id)));
  container.append(search, all, none, invert, list);
}

function renderTargetPicker(container, projectionId) {
  clear(container);
  const descriptor = getProjection(projectionId);
  const current = state.options[projectionId];
  for (const target of descriptor?.targets ?? []) {
    const label = element('label', 'check-row');
    const box = element('input');
    box.type = 'checkbox';
    box.checked = current.targets.includes(target.id);
    box.addEventListener('change', () => {
      const selected = new Set(current.targets);
      if (box.checked) selected.add(target.id);
      else selected.delete(target.id);
      current.targets = descriptor.targets.map((item) => item.id).filter((id) => selected.has(id));
      schedulePreview();
    });
    label.append(box, element('span', 'mono', target.id), element('span', 'hint', ` ${target.name ?? ''}`));
    container.append(label);
  }
}

function renderOptions() {
  const body = byId('options-body');
  const controls = byId('projection-controls');
  if (body === null || controls === null) return;
  clear(controls);
  const hasIr = state.ir !== null;
  show(body, hasIr);
  if (!hasIr) return;
  byId('options-ir-digest').textContent = state.ir.digest;
  for (const projectionId of state.allowed) {
    const descriptor = getProjection(projectionId);
    if (descriptor === null) continue;
    const block = element('div', 'projection-control');
    const head = element('div', 'row');
    head.append(
      element('strong', null, `${descriptor.name ?? descriptor.id} (${descriptor.id} @ ${descriptor.version})`),
      element('span', 'badge', '…'),
    );
    head.lastChild.id = `canonical-${projectionId}`;
    block.append(head);
    const current = state.options[projectionId];

    block.append(element('h4', null, 'Stage order'));
    const orderList = element('ol', 'stage-order');
    renderStageOrder(orderList, projectionId);
    block.append(orderList);
    const restoreOrder = element('button', null, 'IR order');
    restoreOrder.type = 'button';
    restoreOrder.addEventListener('click', () => {
      current.stageOrder = stageIdsOf(state.ir.json);
      renderStageOrder(orderList, projectionId);
      schedulePreview();
    });
    block.append(restoreOrder);

    block.append(element('h4', null, 'Skills'));
    const picker = element('div', 'skill-picker');
    renderSkillPicker(picker, projectionId);
    block.append(picker);

    if ((descriptor.targets ?? []).length > 1) {
      block.append(element('h4', null, 'Targets'));
      const targets = element('div', 'target-picker');
      renderTargetPicker(targets, projectionId);
      block.append(targets);
    }
    controls.append(block);
  }
}

function bytesOfContent(content) {
  return new TextEncoder().encode(content).length;
}

function summarizeResult(result) {
  const bytes = result.files.reduce((sum, file) => sum + bytesOfContent(file.content), 0);
  return {
    id: result.projection.id,
    version: result.projection.version,
    options: result.options,
    targets: result.targets,
    coverage: result.coverage,
    counts: {
      files: result.files.length,
      bytes,
      degradations: result.degradations.length,
      warnings: result.warnings.length,
      capabilities: result.capabilityReport.length,
    },
    files: result.files.map((file) => ({
      path: file.path,
      targets: file.targets,
      kind: file.kind,
      mode: file.mode,
    })),
    capabilityReport: result.capabilityReport,
    degradations: result.degradations,
    warnings: result.warnings,
    metadata: result.metadata,
  };
}

function groupBy(items, keyOf) {
  const groups = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

function renderProjectionSummary(parent, summary, digest, canonical) {
  const block = element('div', 'projection-result');
  const head = element('div', 'row');
  head.append(
    element('strong', null, `${summary.id} @ ${summary.version}`),
    element('span', canonical ? 'badge badge-ok' : 'badge badge-warn', canonical ? 'canonical · publishable' : 'custom · local only'),
  );
  block.append(head);

  const counts = element('div', 'summary');
  const byKind = groupBy(summary.files, (file) => file.kind);
  const byTarget = groupBy(summary.files.flatMap((file) => file.targets.map((target) => ({ target }))), (item) => item.target);
  counts.append(element('p', null, `files ${summary.counts.files} · bytes ${formatBytes(summary.counts.bytes)} · degradations ${summary.counts.degradations} · warnings ${summary.counts.warnings} · capabilities ${summary.counts.capabilities}`));
  counts.append(element('p', 'hint', `by kind: ${[...byKind.entries()].map(([kind, list]) => `${kind} ${list.length}`).join(', ') || 'none'}`));
  counts.append(element('p', 'hint', `by target: ${[...byTarget.entries()].map(([target, list]) => `${target} ${list.length}`).join(', ') || 'none'}`));
  counts.append(element('p', 'mono hint', `coverage stages ${summary.coverage.stages.length} · steps ${summary.coverage.steps.length}`));
  if (digest !== undefined && digest !== null) counts.append(element('p', 'mono hint', `result digest ${digest}`));
  block.append(counts);

  block.append(element('h4', null, 'Capability matrix'));
  const matrix = element('table', 'matrix');
  const header = element('tr');
  for (const label of ['target', 'capability', 'level', 'uses']) header.append(element('th', null, label));
  matrix.append(header);
  for (const row of summary.capabilityReport) {
    const tr = element('tr');
    tr.append(
      element('td', 'mono', row.target),
      element('td', 'mono', row.capability),
      element('td', null, row.level),
      element('td', 'mono', String(row.uses)),
    );
    matrix.append(tr);
  }
  block.append(matrix);

  block.append(element('h4', null, 'Degradations'));
  if (summary.degradations.length === 0) block.append(element('p', 'hint', 'none'));
  const groups = groupBy(summary.degradations, (item) => `${item.target}/${item.capability}`);
  for (const [key, items] of groups) {
    const details = element('details');
    details.append(element('summary', null, `${key} (${items.length})`));
    const list = element('ul', 'degradations');
    for (const item of items) {
      list.append(element('li', null, `${item.level} · ${item.pointer}${item.field ? ` · ${item.field}` : ''} — ${item.reason} → ${item.effect}`));
    }
    details.append(list);
    block.append(details);
  }

  block.append(element('h4', null, 'Warnings'));
  if (summary.warnings.length === 0) block.append(element('p', 'hint', 'none'));
  const warnings = element('ul', 'warnings');
  for (const warning of summary.warnings) {
    warnings.append(element('li', null, `${warning.code} · ${warning.pointer ?? warning.target ?? ''} — ${warning.message}`));
  }
  block.append(warnings);

  const files = element('details');
  files.append(element('summary', null, `Files (${summary.files.length})`));
  const fileList = element('ul', 'file-list');
  for (const file of summary.files) {
    const row = element('li');
    row.append(
      element('span', 'mono', file.path),
      element('span', 'hint', ` ${file.kind} · ${file.targets.join(',')} · ${file.mode === 0o755 ? '0755' : '0644'}`),
    );
    fileList.append(row);
  }
  files.append(fileList);
  block.append(files);
  parent.append(block);
}

async function preview() {
  const body = byId('preview-body');
  const status = byId('preview-status');
  const button = byId('build-button');
  if (body === null) return;
  clear(body);
  if (button !== null) button.disabled = true;
  if (state.ir === null) {
    show(body, false);
    if (status !== null) status.textContent = 'Upload a valid bundle to preview projections.';
    return;
  }
  if (state.allowed.length === 0) {
    show(body, false);
    if (status !== null) status.textContent = 'This IR allows no registered projection.';
    return;
  }
  show(body, true);
  const previews = {};
  let ok = true;
  for (const projectionId of state.allowed) {
    const descriptor = getProjection(projectionId);
    if (descriptor === null) continue;
    const raw = state.options[projectionId] ? optionsForRequest()[projectionId] : null;
    const normalized = normalizeOptions({
      projectionId,
      ir: state.ir.json,
      irDigest: state.ir.digest,
      raw,
      manifest: descriptor,
    });
    if (!normalized.ok) {
      ok = false;
      const block = element('div', 'banner banner-error');
      block.append(element('strong', null, 'Invalid options'));
      const list = element('ul');
      for (const error of normalized.errors) list.append(element('li', null, `${error.code}: ${error.message}`));
      block.append(list);
      body.append(block);
      continue;
    }
    const result = project({
      projectionId,
      ir: state.ir.json,
      irDigest: state.ir.digest,
      options: normalized.options,
      environment: { engineVersion: state.engineVersion },
      assets: {},
    });
    if (!result.ok) {
      ok = false;
      const block = element('div', 'banner banner-error');
      block.append(element('strong', null, 'Projection failed'));
      for (const error of result.errors ?? []) block.append(element('p', null, `${error.code}: ${error.message}`));
      body.append(block);
      continue;
    }
    const validation = validateResult(result, {
      ir: state.ir.json,
      irDigest: state.ir.digest,
      manifest: descriptor,
      options: normalized.options,
      environment: { engineVersion: state.engineVersion },
      assets: {},
    });
    if (!validation.ok) {
      ok = false;
      const block = element('div', 'banner banner-error');
      block.append(element('strong', null, 'Projection result failed V1–V12'));
      for (const diagnostic of validation.diagnostics) block.append(element('p', null, `${diagnostic.code}: ${diagnostic.message}`));
      body.append(block);
      continue;
    }
    const digest = await sha256Hex(canonicalJson(result));
    const canonical = isCanonicalOptions({
      projectionId,
      ir: state.ir.json,
      irDigest: state.ir.digest,
      options: normalized.options,
      manifest: descriptor,
    });
    previews[projectionId] = { digest, canonical };
    renderProjectionSummary(body, summarizeResult(result), digest, canonical);
  }
  state.previews = previews;
  for (const [projectionId, info] of Object.entries(previews)) {
    const badge = byId(`canonical-${projectionId}`);
    if (badge === null) continue;
    badge.textContent = info.canonical ? 'canonical' : 'custom (local only)';
    badge.className = info.canonical ? 'badge badge-ok' : 'badge badge-warn';
  }
  if (status !== null) {
    status.textContent = ok
      ? `Preview computed in the browser with the shared modules (${Object.keys(previews).length} projection(s)).`
      : 'Fix the options above; no build is possible while they are invalid.';
  }
  if (button !== null) button.disabled = !ok || state.uploadId === null;
}

function copyable(text) {
  const row = element('div', 'command');
  row.append(element('code', null, text));
  const button = element('button', null, 'Copy');
  button.type = 'button';
  button.addEventListener('click', () => {
    const clipboard = navigator.clipboard;
    if (clipboard === undefined || typeof clipboard.writeText !== 'function') {
      button.textContent = 'Copy unavailable';
      return;
    }
    clipboard.writeText(text).then(() => { button.textContent = 'Copied'; }, () => { button.textContent = 'Copy failed'; });
  });
  row.append(button);
  return row;
}

function renderBuild(build) {
  state.build = build;
  const body = byId('build-body');
  if (body === null) return;
  clear(body);
  show(body, true);

  const head = element('div', 'row');
  head.append(
    element('span', 'mono', `build ${build.buildId}`),
    element('span', build.publishable ? 'badge badge-ok' : 'badge badge-warn', build.publishable ? 'publishable' : 'local only (publishable: false)'),
    element('span', 'mono hint', build.tag),
  );
  body.append(head);

  body.append(element('h3', null, build.install.mode === 'release' ? 'Install commands (fixed version)' : 'Install commands (local mirror)'));
  body.append(element('p', 'hint', 'Run from the target project root. The web surface never writes to a project.'));
  for (const item of build.install.commands) {
    body.append(copyable(item.command));
  }

  body.append(element('h3', null, 'Assets'));
  const assets = element('ul', 'asset-list');
  for (const asset of build.artifacts) {
    const item = element('li');
    const link = element('a', null, asset.name);
    link.href = asset.url;
    link.setAttribute('download', asset.name);
    item.append(link, element('span', 'hint', ` ${formatBytes(asset.bytes)} · sha256 ${asset.sha256}`));
    assets.append(item);
  }
  body.append(assets);

  body.append(element('h3', null, 'Projection results'));
  for (const projection of build.projections) {
    renderProjectionSummary(body, projection, projection.digest, build.canonical);
  }
}

async function buildAssets() {
  const status = byId('build-status');
  if (state.ir === null || state.uploadId === null) return;
  if (status !== null) status.textContent = 'Building on the server…';
  let payload;
  try {
    const response = await fetch('/api/builds', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-R2C-CSRF': state.csrf ?? '',
      },
      body: JSON.stringify({
        uploadId: state.uploadId,
        irDigest: state.ir.digest,
        options: optionsForRequest(),
      }),
      cache: 'no-store',
      credentials: 'omit',
    });
    payload = await response.json();
    if (!response.ok) {
      const code = payload?.error?.code ?? `HTTP_${response.status}`;
      const details = payload?.error?.details;
      if (status !== null) {
        const suffix = details === null || details === undefined ? '' : ` — ${JSON.stringify(details)}`;
        status.textContent = `${code}: ${payload?.error?.message ?? 'build failed'}${suffix}`;
      }
      return;
    }
  } catch (error) {
    if (status !== null) status.textContent = `Build failed: ${error instanceof Error ? error.message : String(error)}`;
    return;
  }
  const build = payload.data;
  for (const projection of build.projections) {
    const local = state.previews[projection.id];
    if (local !== undefined && local.digest !== projection.digest) {
      setMismatch(`Result digest mismatch for ${projection.id}: browser ${local.digest}, server ${projection.digest}.`);
    }
  }
  renderBuild(build);
  if (status !== null) {
    status.textContent = build.publishable
      ? `Canonical build: ${build.artifacts.length} assets, publishable.`
      : `Custom options: ${build.artifacts.length} local-only assets (publishable: false).`;
  }
}

/* -------------------------------------------------------------------------- */
/* Comparison                                                                 */
/* -------------------------------------------------------------------------- */

function setMismatch(message) {
  state.mismatch = true;
  const banner = byId('mismatch');
  const text = byId('mismatch-text');
  if (text !== null) text.textContent = message;
  show(banner, true);
  const publish = byId('publish-badge');
  publish.textContent = 'publish disabled: client/server mismatch';
  publish.className = 'badge badge-error';
}

function clearMismatch() {
  state.mismatch = false;
  show(byId('mismatch'), false);
  const publish = byId('publish-badge');
  publish.textContent = 'publish disabled (read-only)';
  publish.className = 'badge badge-warn';
}

function sameReport(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/* -------------------------------------------------------------------------- */
/* Upload                                                                     */
/* -------------------------------------------------------------------------- */

function selectedFile() {
  const input = byId('file-input');
  return input?.files?.[0] ?? null;
}

function refreshButton() {
  const button = byId('upload-button');
  if (button !== null) button.disabled = selectedFile() === null;
}

async function upload() {
  const file = selectedFile();
  if (file === null) return;
  clearMismatch();
  setStatus('Reading file…');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length > LIMITS.MAX_ZIP_BYTES) {
    renderNoIr();
    setStatus(`WEB_BODY_TOO_LARGE: ${formatBytes(bytes.length)} exceeds ${formatBytes(LIMITS.MAX_ZIP_BYTES)}.`);
    return;
  }

  let localReport = null;
  if (!state.degraded) {
    setStatus('Validating in the browser with the shared validator…');
    try {
      localReport = await validateBundleAsync(bytes, { inflateRaw, sha256: sha256Hex }, { path: 'bundle.zip' });
    } catch (error) {
      setStatus(`Browser validation failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
  } else {
    setStatus('deflate-raw unavailable: using the server for validation; IR preview stays in the browser.');
  }

  setStatus('Uploading for authoritative validation and compilation…');
  let payload;
  try {
    const response = await fetch('/api/uploads', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/zip',
        'X-R2C-CSRF': state.csrf ?? '',
      },
      body: bytes,
      cache: 'no-store',
      credentials: 'omit',
    });
    payload = await response.json();
    if (!response.ok) {
      const code = payload?.error?.code ?? `HTTP_${response.status}`;
      setStatus(`${code}: ${payload?.error?.message ?? 'upload rejected'}`);
      return;
    }
  } catch (error) {
    setStatus(`Upload failed: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const data = payload?.data;
  if (!data || !data.report) {
    setStatus('WEB_CLIENT_SERVER_MISMATCH: server response has no report');
    setMismatch('The server response did not contain a validation report.');
    return;
  }

  if (localReport !== null && !sameReport(localReport, data.report)) {
    setMismatch('The browser Report differs from the server Report for the same bytes.');
  }
  renderReport(data.report);

  if (data.ir) {
    try {
      const digest = await sha256Hex(decodeBase64(data.ir.data));
      if (digest !== data.ir.digest) {
        setMismatch(`IR digest mismatch: browser ${digest}, server ${data.ir.digest}.`);
      }
      renderIr(data);
      state.uploadId = data.uploadId ?? null;
      const buildBody = byId('build-body');
      if (buildBody !== null) show(buildBody, false);
      state.build = null;
      resetOptions('New upload: options were reset to the published defaults.');
    } catch (error) {
      setMismatch(`IR could not be verified: ${error instanceof Error ? error.message : String(error)}`);
      renderNoIr();
    }
  } else {
    renderNoIr();
  }

  const counts = data.report.counts ?? {};
  setStatus(`Server report: ${data.report.ok ? 'valid' : 'invalid'} — ${counts.errors ?? 0} error(s), ${counts.warnings ?? 0} warning(s).`);
}

/* -------------------------------------------------------------------------- */
/* Bootstrap                                                                  */
/* -------------------------------------------------------------------------- */

async function bootstrap() {
  const floor = probeBrowserFloor();
  state.floor = floor;
  window.__R2C_FLOOR__ = floor;
  const missing = missingRequirements(floor);
  if (missing.length > 0) {
    showFallback(missing);
    return;
  }
  window.__R2C_BOOTED__ = true;
  show(byId('fatal'), false);

  state.degraded = !floor.deflateRaw;
  const mode = byId('mode-badge');
  if (mode !== null) mode.textContent = state.degraded ? 'build · server validation' : 'build · shared validator';
  const degrade = byId('degrade-badge');
  if (state.degraded && degrade !== null) {
    degrade.textContent = "degraded: no DecompressionStream('deflate-raw')";
    degrade.hidden = false;
  }

  const limitText = byId('limit-text');
  if (limitText !== null) limitText.textContent = formatBytes(LIMITS.MAX_ZIP_BYTES);

  let session;
  try {
    const response = await fetch('/api/session', { cache: 'no-store', credentials: 'omit' });
    session = await response.json();
    if (!response.ok || !session?.data?.csrf) throw new Error('session unavailable');
  } catch (error) {
    setStatus(`Local server unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  state.csrf = session.data.csrf;
  state.limits = session.data.limits;
  state.engineVersion = session.data.engineVersion ?? null;
  state.shared = await loadSharedModules(session.data.modules ?? {});
  if (session.data.publish?.enabled !== true) {
    const publish = byId('publish-badge');
    publish.textContent = `publish disabled (${session.data.publish?.reason ?? 'read-only'})`;
  }

  const input = byId('file-input');
  input.addEventListener('change', refreshButton);
  byId('upload-button').addEventListener('click', () => {
    void upload();
  });
  byId('download-ir').addEventListener('click', downloadIr);
  byId('reset-options').addEventListener('click', () => resetOptions());
  byId('build-button').addEventListener('click', () => {
    void buildAssets();
  });
  byId('severity-filter').addEventListener('change', renderDiagnostics);
  byId('path-filter').addEventListener('input', renderDiagnostics);
  byId('upload-button').disabled = selectedFile() === null;
  setStatus(`Ready. Import roots: ${webManifest.imports.join(', ')}.`);
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  void bootstrap().catch((error) => {
    showFallback([error instanceof Error ? error.message : String(error)]);
  });
}

export { state, upload, bootstrap, preview, resetOptions, buildAssets };
