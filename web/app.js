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
  report: null,
  diagnostics: [],
  shared: null,
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
    const response = await fetch('/api/validate', {
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
  if (mode !== null) mode.textContent = state.degraded ? 'read-only · server validation' : 'read-only · shared validator';
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

export { state, upload, bootstrap };
