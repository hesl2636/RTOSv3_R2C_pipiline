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
import { compareCodePoints } from '../core/code-point.js';
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
import { publishButtonState } from './publish-state.js';
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
  publish: null,
  publishJob: null,
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
  window.__HM2B_BOOT_REASONS__ = reasons;
  if (typeof window.__hm2bShowFallback === 'function') window.__hm2bShowFallback(reasons);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '未知';
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

function statCard(label, value, tone) {
  const card = element('div', tone ? `stat stat-${tone}` : 'stat');
  card.append(element('span', 'stat-value', value), element('span', 'stat-label', label));
  return card;
}

function countChip(label, count, tone) {
  const chip = element('span', tone ? `count-chip is-${tone}` : 'count-chip');
  chip.append(document.createTextNode(label), element('strong', null, String(count ?? 0)));
  return chip;
}

function constitutionInfo(ir) {
  const name = constitutionState(ir);
  if (name === 'placeholder') return { name, label: '占位', tone: 'warn' };
  if (name === 'present') return { name, label: '已提供', tone: 'ok' };
  return { name, label: '未声明', tone: 'muted' };
}

function renderOverview(report) {
  const panel = byId('overview');
  if (panel === null) return;
  if (report === null) {
    show(panel, false);
    return;
  }
  const ir = state.ir?.json ?? null;
  const assets = ir === null ? null : declaredAssets(ir);
  const counts = report.counts ?? {};
  const errors = counts.errors ?? 0;
  const warnings = counts.warnings ?? 0;
  const grid = byId('overview-grid');
  clear(grid);
  grid.append(
    statCard('校验', report.ok === true ? '通过' : '失败', report.ok === true ? 'ok' : 'bad'),
    statCard('错误', errors, errors > 0 ? 'bad' : 'muted'),
    statCard('警告', warnings, warnings > 0 ? 'warn' : 'muted'),
  );
  if (ir !== null && assets !== null) {
    grid.append(
      statCard('阶段', (ir.stages ?? []).length, 'muted'),
      statCard('角色', Object.keys(ir.roles ?? {}).length, 'muted'),
      statCard('任务', Object.keys(ir.tasks ?? {}).length, 'muted'),
      statCard('技能', Object.keys(ir.skills ?? {}).length, 'muted'),
      statCard('宪法', constitutionInfo(ir).label, constitutionInfo(ir).tone),
      statCard('四类资产', assets.knowledgeBase.length + assets.checklists.length + assets.hooks.length + assets.mcp.length, 'muted'),
    );
  }
  const chip = byId('overview-bundle');
  if (chip !== null) chip.textContent = `${ir?.id ?? report.id ?? '—'} @ ${ir?.version ?? report.version ?? '—'}`;

  const meta = byId('overview-meta');
  clear(meta);
  appendKeyValue(meta, 'schema', report.schema);
  appendKeyValue(meta, '产物', report.artifact?.path);
  appendKeyValue(meta, '大小', formatBytes(report.artifact?.bytes));
  appendKeyValue(meta, 'zip sha256', report.artifact?.sha256);
  if (ir !== null) {
    appendKeyValue(meta, 'IR 摘要', state.ir?.digest);
    appendKeyValue(meta, 'contentSha256', ir.source?.bundle?.contentSha256);
    appendKeyValue(meta, 'requires', JSON.stringify(ir.requires ?? {}));
  }
  show(panel, true);
}

function renderSummary(report) {
  const summary = byId('report-summary');
  clear(summary);
  const counts = report.counts ?? {};
  summary.append(
    countChip('错误', counts.errors ?? 0, (counts.errors ?? 0) > 0 ? 'bad' : ''),
    countChip('警告', counts.warnings ?? 0, (counts.warnings ?? 0) > 0 ? 'warn' : ''),
  );
  if (report.artifact?.bytes !== undefined) {
    summary.append(countChip('大小', formatBytes(report.artifact.bytes), ''));
  }
  show(summary, true);
  show(byId('report-body'), true);
}

function renderHighlights() {
  const list = byId('report-highlights');
  if (list === null) return;
  clear(list);
  const shown = state.diagnostics.slice(0, 3);
  for (const diagnostic of shown) {
    const item = element('li', `is-${diagnostic.severity}`);
    item.append(
      element('span', `sev sev-${diagnostic.severity}`, diagnostic.severity === 'error' ? '错误' : '警告'),
      element('span', 'mono code', diagnostic.code),
      element('span', 'message', diagnostic.message),
    );
    list.append(item);
    item.title = locationOf(diagnostic);
  }
  if (state.diagnostics.length > shown.length) {
    list.append(element('li', 'more', `另有 ${state.diagnostics.length - shown.length} 条，展开“全部诊断”查看。`));
  }
  show(list, shown.length > 0);
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
      element('span', `sev sev-${diagnostic.severity}`, diagnostic.severity === 'error' ? '错误' : '警告'),
      element('span', 'mono code', diagnostic.code),
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
  const count = byId('diagnostic-count');
  if (count !== null) count.textContent = `(${diagnostics.length}/${state.diagnostics.length})`;
  show(byId('diagnostics-empty'), diagnostics.length === 0);
}

function renderReport(report) {
  state.report = report;
  state.diagnostics = [...(report.errors ?? []), ...(report.warnings ?? [])];
  renderSummary(report);
  renderDiagnostics();
  renderHighlights();
  const verdict = byId('report-verdict');
  if (verdict !== null) {
    verdict.textContent = report.ok === true ? '校验通过' : '校验失败';
    verdict.className = report.ok === true ? 'pill pill-ok' : 'pill pill-bad';
    show(verdict, true);
  }
  const details = byId('report-details');
  if (details !== null) details.open = (report.counts?.errors ?? 0) > 0;
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
      if (step.role !== undefined) details.push(`角色 ${step.role}`);
      if (step.task !== undefined) details.push(`任务 ${step.task}`);
      if (Array.isArray(step.skills) && step.skills.length > 0) details.push(`${step.skills.length} 个技能`);
      if (Array.isArray(step.gates) && step.gates.length > 0) details.push(`${step.gates.length} 个门禁`);
      if (Array.isArray(step.outputs) && step.outputs.length > 0) details.push(`${step.outputs.length} 个输出`);
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
    if (role.placeholder === true) item.append(element('span', 'badge badge-warn', '占位'));
    item.append(element('p', null, role.description ?? ''));
    if (Array.isArray(role.skills) && role.skills.length > 0) {
      item.append(element('p', 'hint', `预载技能：${role.skills.join(', ')}`));
    }
    const source = sourceLine(role.source);
    if (source !== '') item.append(element('p', 'mono hint', source));
    const body = element('details');
    body.append(element('summary', null, '指令（只读）'), element('pre', 'raw', role.instructions ?? ''));
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
    body.append(element('summary', null, '正文（只读）'), element('pre', 'raw', task.body ?? ''));
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
    if (skill.placeholder === true) item.append(element('span', 'badge badge-warn', '占位'));
    item.append(element('p', null, skill.description ?? ''));
    const source = sourceLine(skill.source);
    if (source !== '') item.append(element('p', 'mono hint', source));
    list.append(item);
  }
}

/**
 * Declared bundle assets (`knowledgeBase`, `checklists`, `hooks`, `mcp`) are
 * rendered verbatim from the IR: the validator owns the rules, so an absent
 * collection is just an empty list and never a client-side failure.
 */
function renderDeclaredAssets(listId, entries, labelOf) {
  const list = byId(listId);
  clear(list);
  if (entries.length === 0) {
    list.append(element('li', 'hint', '未声明'));
    return;
  }
  for (const entry of entries) {
    const item = element('li');
    item.append(element('strong', null, labelOf(entry)));
    const source = sourceLine(entry.source);
    if (source !== '') item.append(element('p', 'mono hint', source));
    const body = element('details');
    body.append(element('summary', null, '正文（只读）'), element('pre', 'raw', entry.body ?? ''));
    item.append(body);
    list.append(item);
  }
}

function declaredAssets(ir) {
  const knowledgeBase = Array.isArray(ir.knowledgeBase) ? ir.knowledgeBase : [];
  const checklists = Array.isArray(ir.checklists) ? ir.checklists : [];
  return {
    knowledgeBase,
    checklists,
    hooks: ir.hooks === null || ir.hooks === undefined ? [] : [ir.hooks],
    mcp: ir.mcp === null || ir.mcp === undefined ? [] : [ir.mcp],
  };
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
  appendKeyValue(identity, 'schema', ir.schema);
  appendKeyValue(identity, 'id', ir.id);
  appendKeyValue(identity, '名称', ir.name);
  appendKeyValue(identity, '版本', ir.version);
  appendKeyValue(identity, '大小', formatBytes(irBytes.length));
  const assets = declaredAssets(ir);

  renderStages(ir);
  renderRoles(ir);
  renderTasks(ir);
  renderSkills(ir);
  renderDeclaredAssets('ir-knowledge-base', assets.knowledgeBase, (entry) => entry.path);
  renderDeclaredAssets('ir-checklists', assets.checklists, (entry) => entry.id);
  renderDeclaredAssets('ir-hooks', assets.hooks, (entry) => entry.path);
  renderDeclaredAssets('ir-mcp', assets.mcp, (entry) => entry.path);

  byId('ir-stage-count').textContent = `· ${(ir.stages ?? []).length} 个阶段`;
  byId('ir-role-count').textContent = `· ${Object.keys(ir.roles ?? {}).length}`;
  byId('ir-task-count').textContent = `· ${Object.keys(ir.tasks ?? {}).length}`;
  byId('ir-skill-count').textContent = `· ${Object.keys(ir.skills ?? {}).length}`;
  byId('ir-asset-count').textContent = `· ${assets.knowledgeBase.length + assets.checklists.length + assets.hooks.length + assets.mcp.length} 项`;

  const constitution = byId('ir-constitution');
  clear(constitution);
  const mounts = Array.isArray(ir.constitution) ? ir.constitution : [];
  const constitutionInfoValue = constitutionInfo(ir);
  const constitutionText = constitutionInfoValue.label;
  const stateSpan = byId('ir-constitution-state');
  if (stateSpan !== null) stateSpan.textContent = `· ${constitutionText}`;
  constitution.append(element('p', `status constitution-${constitutionInfoValue.name}`, `${constitutionText} · ${mounts.length} 个挂载`));
  for (const mount of mounts) {
    const item = element('div', 'entity');
    item.append(element('strong', null, `${mount.scope ?? 'global'}${mount.placeholder === true ? ' · 占位' : ''}`));
    const source = sourceLine(mount.source);
    if (source !== '') item.append(element('p', 'mono hint', source));
    const body = element('details');
    body.append(element('summary', null, '正文（只读）'), element('pre', 'raw', mount.body ?? ''));
    item.append(body);
    constitution.append(item);
  }

  byId('ir-digest').textContent = `sha256 ${data.ir.digest}`;
  byId('download-ir').disabled = false;
  const summary = byId('ir-summary');
  if (summary !== null) summary.textContent = `${ir.id} @ ${ir.version} · ${formatBytes(irBytes.length)}`;
  byId('ir-raw').textContent = text;
  show(byId('ir-empty'), false);
  show(byId('ir-body'), true);
  renderOverview(state.report);
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
  show(byId('overview'), false);
  byId('download-ir').disabled = true;
  byId('ir-empty').textContent = '未生成 IR：bundle 必须先无错误通过校验，才能编译。';
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
  return Object.keys(ir.skills ?? {}).sort(compareCodePoints);
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
  if (status !== null) status.textContent = message ?? '已恢复默认选项。';
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
    up.title = '上移';
    up.disabled = index === 0;
    up.addEventListener('click', () => {
      const order = current.stageOrder;
      [order[index - 1], order[index]] = [order[index], order[index - 1]];
      renderStageOrder(list, projectionId);
      schedulePreview();
    });
    const down = element('button', null, '↓');
    down.type = 'button';
    down.title = '下移';
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

function renderSkillPicker(container, projectionId, countNode) {
  clear(container);
  const current = state.options[projectionId];
  const search = element('input');
  search.type = 'text';
  search.placeholder = '筛选技能';
  search.setAttribute('spellcheck', 'false');
  const all = element('button', null, '全选');
  const none = element('button', null, '清空');
  const invert = element('button', null, '反选');
  for (const button of [all, none, invert]) button.type = 'button';
  const list = element('ul', 'check-list');
  const rows = [];
  const syncCount = () => {
    if (countNode !== null) countNode.textContent = `${current.skills.length}/${rows.length}`;
  };
  for (const [id, skill] of Object.entries(state.ir?.json.skills ?? {})) {
    const label = element('label', 'check-row');
    const box = element('input');
    box.type = 'checkbox';
    box.checked = current.skills.includes(id);
    box.addEventListener('change', () => {
      const selected = new Set(current.skills);
      if (box.checked) selected.add(id);
      else selected.delete(id);
      current.skills = [...selected].sort(compareCodePoints);
      syncCount();
      schedulePreview();
    });
    label.append(box, element('span', 'mono', id));
    if (skill.placeholder === true) label.append(element('span', 'badge badge-warn', '占位'));
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
    current.skills = rows.filter((row) => predicate(row.id)).map((row) => row.id).sort(compareCodePoints);
    syncCount();
    schedulePreview();
  };
  search.addEventListener('input', applyFilter);
  all.addEventListener('click', () => setAll(() => true));
  none.addEventListener('click', () => setAll(() => false));
  invert.addEventListener('click', () => setAll((id) => !current.skills.includes(id)));
  syncCount();
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
  if (!hasIr) {
    const count = byId('options-count');
    if (count !== null) count.textContent = '—';
    return;
  }
  byId('options-ir-digest').textContent = state.ir.digest;
  byId('options-count').textContent = `${state.allowed.length} 个投影`;
  for (const projectionId of state.allowed) {
    const descriptor = getProjection(projectionId);
    if (descriptor === null) continue;
    const block = element('details', 'projection-control fold');
    const summary = element('summary');
    const badge = element('span', 'badge', '…');
    badge.id = `canonical-${projectionId}`;
    summary.append(
      element('strong', null, descriptor.name ?? descriptor.id),
      element('span', 'mono hint', descriptor.id),
      badge,
      element('span', 'hint', `${skillIdsOf(state.ir.json).length} 个技能 · ${(descriptor.targets ?? []).length} 个目标`),
    );
    block.append(summary);
    const current = state.options[projectionId];

    const orderGroup = element('div', 'option-group');
    orderGroup.append(element('h4', null, '阶段顺序'));
    const orderList = element('ol', 'stage-order');
    renderStageOrder(orderList, projectionId);
    const restoreOrder = element('button', null, '恢复 IR 顺序');
    restoreOrder.type = 'button';
    restoreOrder.addEventListener('click', () => {
      current.stageOrder = stageIdsOf(state.ir.json);
      renderStageOrder(orderList, projectionId);
      schedulePreview();
    });
    orderGroup.append(orderList, restoreOrder);
    block.append(orderGroup);

    const skillFold = element('details', 'fold');
    const skillSummary = element('summary');
    const skillCount = element('span', 'count', '');
    skillSummary.append(document.createTextNode('技能选择 '), skillCount);
    const picker = element('div', 'skill-picker');
    renderSkillPicker(picker, projectionId, skillCount);
    skillFold.append(skillSummary, picker);
    block.append(skillFold);

    if ((descriptor.targets ?? []).length > 1) {
      const targetGroup = element('div', 'option-group');
      targetGroup.append(element('h4', null, '目标宿主'));
      const targets = element('div', 'target-picker');
      renderTargetPicker(targets, projectionId);
      targetGroup.append(targets);
      block.append(targetGroup);
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
  const block = element('details', 'projection-result fold');
  const head = element('summary');
  head.append(
    element('strong', null, `${summary.id} @ ${summary.version}`),
    element('span', canonical ? 'badge badge-ok' : 'badge badge-warn', canonical ? '可发布' : '仅本地'),
    element('span', 'hint', `${summary.counts.files} 文件 · ${summary.counts.degradations} 降级 · ${summary.counts.warnings} 警告`),
  );
  block.append(head);

  const counts = element('div', 'summary');
  const byKind = groupBy(summary.files, (file) => file.kind);
  counts.append(
    countChip('文件', summary.counts.files, ''),
    countChip('体积', formatBytes(summary.counts.bytes), ''),
    countChip('降级', summary.counts.degradations, summary.counts.degradations > 0 ? 'warn' : ''),
    countChip('警告', summary.counts.warnings, summary.counts.warnings > 0 ? 'warn' : ''),
  );
  block.append(counts);
  block.append(element('p', 'hint', `覆盖 ${summary.coverage.stages.length} 个阶段 / ${summary.coverage.steps.length} 个步骤`));
  if (digest !== undefined && digest !== null) {
    const meta = element('p', 'mono hint', `result sha256 ${digest}`);
    meta.title = digest;
    block.append(meta);
  }
  block.append(element('p', 'hint', `按类型：${[...byKind.entries()].map(([kind, list]) => `${kind} ${list.length}`).join('，') || '无'}`));

  const cap = element('details', 'fold');
  const capHead = element('summary');
  capHead.append(document.createTextNode('能力矩阵 '), element('span', 'count', `· ${summary.capabilityReport.length}`));
  const matrix = element('table', 'matrix');
  const header = element('tr');
  for (const label of ['目标', '能力', '级别', '使用点']) header.append(element('th', null, label));
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
  cap.append(capHead, matrix);
  block.append(cap);

  const deg = element('details', 'fold');
  const degHead = element('summary');
  degHead.append(document.createTextNode('降级 '), element('span', 'count', `· ${summary.degradations.length}`));
  deg.append(degHead);
  if (summary.degradations.length === 0) deg.append(element('p', 'hint', '无降级。'));
  const groups = groupBy(summary.degradations, (item) => `${item.target}/${item.capability}`);
  for (const [key, items] of groups) {
    const details = element('details', 'fold');
    details.append(element('summary', null, `${key} (${items.length})`));
    const list = element('ul', 'degradations');
    for (const item of items) {
      list.append(element('li', null, `${item.level} · ${item.pointer}${item.field ? ` · ${item.field}` : ''} — ${item.reason} → ${item.effect}`));
    }
    details.append(list);
    deg.append(details);
  }
  block.append(deg);

  if (summary.warnings.length > 0) {
    const warn = element('details', 'fold');
    const warnHead = element('summary');
    warnHead.append(document.createTextNode('警告 '), element('span', 'count', `· ${summary.warnings.length}`));
    const warnings = element('ul', 'warnings');
    for (const warning of summary.warnings) {
      warnings.append(element('li', null, `${warning.code} · ${warning.pointer ?? warning.target ?? ''} — ${warning.message}`));
    }
    warn.append(warnHead, warnings);
    block.append(warn);
  }

  const files = element('details', 'fold');
  files.append(element('summary', null, `文件清单 · ${summary.files.length}`));
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
    if (status !== null) status.textContent = '请先上传并通过校验，才能预览投影。';
    return;
  }
  if (state.allowed.length === 0) {
    show(body, false);
    if (status !== null) status.textContent = '这个 IR 没有可用的已注册投影。';
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
      block.append(element('strong', null, '选项无效'));
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
      block.append(element('strong', null, '投影失败'));
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
      block.append(element('strong', null, '投影结果未通过 V1–V12'));
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
  const previewCount = byId('preview-count');
  if (previewCount !== null) previewCount.textContent = ok ? `· ${Object.keys(previews).length} 个投影` : '· 选项无效';
  for (const [projectionId, info] of Object.entries(previews)) {
    const badge = byId(`canonical-${projectionId}`);
    if (badge === null) continue;
    badge.textContent = info.canonical ? 'canonical' : 'custom (local only)';
    badge.className = info.canonical ? 'badge badge-ok' : 'badge badge-warn';
  }
  if (status !== null) {
    status.textContent = ok
      ? `已在浏览器用共享模块计算预览（${Object.keys(previews).length} 个投影）。`
      : '请先修正上方选项；选项无效时无法构建。';
  }
  if (button !== null) button.disabled = !ok || state.uploadId === null;
}

function copyable(text) {
  const row = element('div', 'command');
  row.append(element('code', null, text));
  const button = element('button', null, '复制');
  button.type = 'button';
  button.addEventListener('click', () => {
    const clipboard = navigator.clipboard;
    if (clipboard === undefined || typeof clipboard.writeText !== 'function') {
      button.textContent = '无法复制';
      return;
    }
    clipboard.writeText(text).then(() => { button.textContent = '已复制'; }, () => { button.textContent = '复制失败'; });
  });
  row.append(button);
  return row;
}

function publishNote(view) {
  if (view.enabled) return `发布已启用（${state.publish?.repo ?? '已配置仓库'}）`;
  if (state.mismatch) return '发布已禁用：浏览器/服务端不一致';
  if (view.reason === 'no-build') return '发布已禁用：请先构建';
  if (view.reason === 'not-canonical') return '发布已禁用：自定义选项仅本地';
  const reasons = {
    'no-token': '未配置 token',
    'no-repository': '未配置仓库',
    'read-only': '只读模式',
  };
  return `发布已禁用（${reasons[view.reason] ?? view.reason ?? '只读'}）`;
}

function appendInstallCommands(parent, commands) {
  if (!Array.isArray(commands) || commands.length === 0) return;
  parent.append(copyable(commands[0].command));
  if (commands.length === 1) return;
  const fold = element('details', 'fold');
  fold.append(element('summary', null, `其他安装命令 · ${commands.length - 1}`));
  for (const item of commands.slice(1)) fold.append(copyable(item.command));
  parent.append(fold);
}

/**
 * The one rule for the publish button: server credentials + repository, a
 * canonical build, and no client/server mismatch (decision #75 §8.3).
 */
function refreshPublish(message) {
  const view = publishButtonState({
    publish: state.publish,
    build: state.build,
    mismatch: state.mismatch,
  });
  const button = byId('publish-button');
  if (button !== null) button.disabled = !view.enabled;
  const badge = byId('publish-badge');
  if (badge !== null) {
    badge.textContent = publishNote(view);
    badge.className = view.enabled ? 'badge badge-ok' : 'badge badge-warn';
  }
  if (message !== undefined) {
    const status = byId('publish-status');
    if (status !== null) status.textContent = message;
  }
  return view;
}

function publishFailureText(error) {
  if (error === null || error === undefined) return '发布失败';
  const release = error.details?.release;
  const parts = [`${error.code}: ${error.message ?? '发布失败'}`];
  if (release?.state !== null && release?.state !== undefined) parts.push(`状态 ${release.state}`);
  for (const failure of release?.failures ?? []) parts.push(failure);
  if (release?.recovery === 'mark-prerelease-or-new-patch') {
    parts.push('该版本可能已经发布：请标记为 prerelease 或发布新的 patch，不要改写已发布资产');
  } else if (release?.recovery === 'new-patch') {
    parts.push('请发布新的 patch 版本');
  }
  return parts.join(' · ');
}

function renderPublishJob(job) {
  const body = byId('publish-body');
  if (body === null) return;
  clear(body);
  show(body, true);
  const head = element('div', 'row');
  head.append(
    element('span', 'mono', job.tag),
    element('span', job.state === 'PUBLISHED' ? 'badge badge-ok' : job.state === 'FAILED' ? 'badge badge-error' : 'badge badge-warn', job.state),
    element('span', 'mono hint', job.phase),
  );
  body.append(head);
  if (job.error !== null) body.append(element('p', 'status', publishFailureText(job.error)));
  if (job.result?.install?.commands !== undefined) {
    body.append(element('h3', null, '安装命令'));
    const bootstrap = job.result.install.bootstrap;
    if (bootstrap !== null && bootstrap !== undefined) {
      body.append(element('p', 'hint', '从 Release 资产下载 install.mjs 到 .hm2b/bootstrap/，然后在目标项目根目录执行。'));
    }
    appendInstallCommands(body, job.result.install.commands);
    const assetsFold = element('details', 'fold');
    assetsFold.append(element('summary', null, `已发布资产 · ${(job.result.assets ?? []).length}`));
    const list = element('ul', 'asset-list');
    for (const asset of job.result.assets ?? []) {
      list.append(element('li', 'mono', `${asset.name} · ${formatBytes(asset.bytes)} · sha256 ${asset.sha256}`));
    }
    assetsFold.append(list);
    body.append(assetsFold);
  }
  if (Array.isArray(job.log) && job.log.length > 0) {
    const logFold = element('details', 'fold');
    logFold.append(element('summary', null, '发布日志'));
    const log = element('pre', 'raw');
    log.textContent = job.log.join('\n');
    logFold.append(log);
    body.append(logFold);
  }
}

async function pollPublish(jobId) {
  const status = byId('publish-status');
  for (let attempt = 0; attempt < 600; attempt += 1) {
    let payload;
    try {
      const response = await fetch(`/api/publish/${jobId}`, { cache: 'no-store', credentials: 'omit' });
      payload = await response.json();
      if (!response.ok) {
        if (status !== null) status.textContent = `${payload?.error?.code ?? `HTTP_${response.status}`}: ${payload?.error?.message ?? '发布状态不可用'}`;
        return;
      }
    } catch (error) {
      if (status !== null) status.textContent = `发布状态不可用：${error instanceof Error ? error.message : String(error)}`;
      return;
    }
    const job = payload.data;
    state.publishJob = job;
    renderPublishJob(job);
    if (status !== null) status.textContent = `${job.state} · ${job.phase}`;
    if (job.state !== 'RUNNING') {
      if (job.state === 'PUBLISHED') {
        if (status !== null) status.textContent = `已发布 ${job.tag}（release ${String(job.result?.releaseId ?? '')}）。`;
      } else if (status !== null) {
        status.textContent = publishFailureText(job.error);
      }
      refreshPublish();
      return;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
}

async function publishRelease() {
  const status = byId('publish-status');
  const view = refreshPublish();
  if (!view.enabled || state.build === null) return;
  if (status !== null) status.textContent = '正在服务端发布…';
  const resultDigests = {};
  for (const projection of state.build.projections ?? []) resultDigests[projection.id] = projection.digest;
  let payload;
  try {
    const response = await fetch(`/api/builds/${state.build.buildId}/publish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-HM2B-CSRF': state.csrf ?? '',
      },
      body: JSON.stringify({
        confirmTag: state.build.tag,
        irDigest: state.ir?.digest,
        resultDigests,
      }),
      cache: 'no-store',
      credentials: 'omit',
    });
    payload = await response.json();
    if (!response.ok) {
      const code = payload?.error?.code ?? `HTTP_${response.status}`;
      const reason = payload?.error?.details?.reason;
      if (status !== null) {
        status.textContent = `${code}: ${payload?.error?.message ?? '发布失败'}${reason === undefined ? '' : ` (${reason})`}`;
      }
      if (code === 'WEB_CLIENT_SERVER_MISMATCH') setMismatch(payload?.error?.message ?? '浏览器与服务端不一致；发布已禁用。');
      return;
    }
  } catch (error) {
    if (status !== null) status.textContent = `发布失败：${error instanceof Error ? error.message : String(error)}`;
    return;
  }
  await pollPublish(payload.data.jobId);
}

function renderBuild(build) {
  state.build = build;
  const body = byId('build-body');
  if (body === null) return;
  clear(body);
  show(body, true);

  const head = element('div', 'summary');
  head.append(
    element('span', 'mono', `build ${build.buildId}`),
    element('span', build.publishable ? 'badge badge-ok' : 'badge badge-warn', build.publishable ? '可发布' : '仅本地'),
    element('span', 'mono hint', build.tag),
  );
  body.append(head);

  const releaseMode = build.install.mode === 'release';
  body.append(element('h3', null, releaseMode ? '安装命令（固定版本）' : '安装命令（重投影后安装）'));
  if (releaseMode) {
    const bootstrap = build.install.bootstrap;
    if (bootstrap !== null && bootstrap !== undefined) {
      body.append(element('p', 'hint', '从 Release 资产下载 install.mjs 到 .hm2b/bootstrap/，然后在目标项目根目录执行。Web 端不会写入任何项目。'));
    }
  } else {
    body.append(element(
      'p',
      'hint',
      '自定义选项不是 Release 载荷：需要从框架源码执行每条命令，用选中的选项重新投影下载的 workflow.ir.json，再安装结果。',
    ));
  }
  appendInstallCommands(body, build.install.commands);

  const assetsFold = element('details', 'fold');
  assetsFold.append(element('summary', null, `构建资源 · ${build.artifacts.length}`));
  const assets = element('ul', 'asset-list');
  for (const asset of build.artifacts) {
    const item = element('li');
    const link = element('a', null, asset.name);
    link.href = asset.url;
    link.setAttribute('download', asset.name);
    item.append(link, element('span', 'hint', ` ${formatBytes(asset.bytes)} · sha256 ${asset.sha256}`));
    assets.append(item);
  }
  assetsFold.append(assets);
  body.append(assetsFold);

  body.append(element('h3', null, `投影结果 · ${build.projections.length}`));
  for (const projection of build.projections) {
    renderProjectionSummary(body, projection, projection.digest, build.canonical);
  }
  refreshPublish();
}

async function buildAssets() {
  const status = byId('build-status');
  if (state.ir === null || state.uploadId === null) return;
  if (status !== null) status.textContent = '正在服务端构建…';
  let payload;
  try {
    const response = await fetch('/api/builds', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-HM2B-CSRF': state.csrf ?? '',
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
        status.textContent = `${code}: ${payload?.error?.message ?? '构建失败'}${suffix}`;
      }
      return;
    }
  } catch (error) {
    if (status !== null) status.textContent = `构建失败：${error instanceof Error ? error.message : String(error)}`;
    return;
  }
  const build = payload.data;
  for (const projection of build.projections) {
    const local = state.previews[projection.id];
    if (local !== undefined && local.digest !== projection.digest) {
      setMismatch(`投影 ${projection.id} 的结果摘要不一致：浏览器 ${local.digest}，服务端 ${projection.digest}。`);
    }
  }
  renderBuild(build);
  if (status !== null) {
    status.textContent = build.publishable
      ? `默认构建：${build.artifacts.length} 个资源，可发布。`
      : `自定义选项：${build.artifacts.length} 个仅本地资源（publishable: false）。`;
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
  const badge = byId('publish-badge');
  if (badge !== null) badge.className = 'badge badge-error';
  refreshPublish();
}

function clearMismatch() {
  state.mismatch = false;
  show(byId('mismatch'), false);
  refreshPublish();
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
  show(byId('overview'), false);
  setStatus('正在读取文件…');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length > LIMITS.MAX_ZIP_BYTES) {
    renderNoIr();
    setStatus(`WEB_BODY_TOO_LARGE：${formatBytes(bytes.length)} 超过 ${formatBytes(LIMITS.MAX_ZIP_BYTES)}。`);
    return;
  }

  let localReport = null;
  if (!state.degraded) {
    setStatus('正在浏览器中用共享校验器校验…');
    try {
      localReport = await validateBundleAsync(bytes, { inflateRaw, sha256: sha256Hex }, { path: 'bundle.zip' });
    } catch (error) {
      setStatus(`浏览器校验失败：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
  } else {
    setStatus('当前浏览器缺少 deflate-raw：校验交给服务端，IR 预览仍在浏览器内完成。');
  }

  setStatus('正在上传，由服务端做权威校验与编译…');
  let payload;
  try {
    const response = await fetch('/api/uploads', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/zip',
        'X-HM2B-CSRF': state.csrf ?? '',
      },
      body: bytes,
      cache: 'no-store',
      credentials: 'omit',
    });
    payload = await response.json();
    if (!response.ok) {
      const code = payload?.error?.code ?? `HTTP_${response.status}`;
      setStatus(`${code}: ${payload?.error?.message ?? '上传被拒绝'}`);
      return;
    }
  } catch (error) {
    setStatus(`上传失败：${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const data = payload?.data;
  if (!data || !data.report) {
    setStatus('WEB_CLIENT_SERVER_MISMATCH：服务端响应里没有校验报告');
    setMismatch('服务端响应未包含校验报告。');
    return;
  }

  if (localReport !== null && !sameReport(localReport, data.report)) {
    setMismatch('相同字节下，浏览器校验报告与服务端报告不一致。');
  }
  renderReport(data.report);

  if (data.ir) {
    try {
      const digest = await sha256Hex(decodeBase64(data.ir.data));
      if (digest !== data.ir.digest) {
        setMismatch(`IR 摘要不一致：浏览器 ${digest}，服务端 ${data.ir.digest}。`);
      }
      renderIr(data);
      state.uploadId = data.uploadId ?? null;
      const buildBody = byId('build-body');
      if (buildBody !== null) show(buildBody, false);
      state.build = null;
      resetOptions('重新上传后，选项已恢复默认。');
    } catch (error) {
      setMismatch(`IR 校验失败：${error instanceof Error ? error.message : String(error)}`);
      renderNoIr();
    }
  } else {
    renderNoIr();
  }

  const counts = data.report.counts ?? {};
  setStatus(`服务端结果：${data.report.ok ? '通过' : '未通过'} — ${counts.errors ?? 0} 个错误，${counts.warnings ?? 0} 个警告。`);
}

/* -------------------------------------------------------------------------- */
/* Bootstrap                                                                  */
/* -------------------------------------------------------------------------- */

async function bootstrap() {
  const floor = probeBrowserFloor();
  state.floor = floor;
  window.__HM2B_FLOOR__ = floor;
  const missing = missingRequirements(floor);
  if (missing.length > 0) {
    showFallback(missing);
    return;
  }
  window.__HM2B_BOOTED__ = true;
  show(byId('fatal'), false);

  state.degraded = !floor.deflateRaw;
  const mode = byId('mode-badge');
  if (mode !== null) mode.textContent = state.degraded ? '构建 · 服务端校验' : '构建 · 共享校验器';
  const degrade = byId('degrade-badge');
  if (state.degraded && degrade !== null) {
    degrade.textContent = "降级：缺少 DecompressionStream('deflate-raw')";
    degrade.hidden = false;
  }

  const limitText = byId('limit-text');
  if (limitText !== null) limitText.textContent = formatBytes(LIMITS.MAX_ZIP_BYTES);

  let session;
  try {
    const response = await fetch('/api/session', { cache: 'no-store', credentials: 'omit' });
    session = await response.json();
    if (!response.ok || !session?.data?.csrf) throw new Error('session 不可用');
  } catch (error) {
    setStatus(`本地服务不可用：${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  state.csrf = session.data.csrf;
  state.limits = session.data.limits;
  state.engineVersion = session.data.engineVersion ?? null;
  state.shared = await loadSharedModules();
  state.publish = session.data.publish ?? null;
  refreshPublish(session.data.publish?.enabled === true
    ? `发布到 ${session.data.publish.repo} 在服务端执行；本页面不会接触 token。`
    : `发布未启用（${session.data.publish?.reason ?? '只读'}）；校验、预览和本地构建仍然可用。`);

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
  byId('publish-button').addEventListener('click', () => {
    void publishRelease();
  });
  byId('severity-filter').addEventListener('change', renderDiagnostics);
  byId('path-filter').addEventListener('input', renderDiagnostics);
  byId('upload-button').disabled = selectedFile() === null;
  setStatus(`就绪。导入根：${webManifest.imports.join(', ')}。`);
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  void bootstrap().catch((error) => {
    showFallback([error instanceof Error ? error.message : String(error)]);
  });
}

export { state, upload, bootstrap, preview, resetOptions, buildAssets, publishRelease };
