/**
 * The observable assertions behind `r2c acceptance`.
 *
 * Each check returns `{ status, detail }` and throws a CheckError on failure.
 * A CheckError may carry the subprocess exit code that must be promoted to the
 * aggregate command (4 = not installed / agent missing, 5 = lock conflict).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BIN,
  CLI_SESSION,
  COMMAND_IDS,
  FIXTURE_DIR,
  REPO_ROOT,
  RUN_ID,
  SESSION,
  SESSION_2,
  artifact,
  claims,
  envelope,
  eventsPath,
  latestPath,
  normalizeEvents,
  normalizeState,
  readEvents,
  readJsonIfExists,
  readLatest,
  readState,
  snapshotR2c,
  statePath,
  submitLine,
  spawnSyncRetry,
  writeState,
} from './harness.js';

export class CheckError extends Error {
  constructor(message, exitCode = null) {
    super(message);
    this.name = 'CheckError';
    this.exitCode = exitCode;
  }
}

function excerpt(result) {
  const stream = (result.stderr || '').trim() || (result.stdout || '').trim()
    || (result.error === undefined ? '' : String(result.error.message ?? result.error));
  return stream.split(/\r?\n/).slice(0, 3).join(' | ');
}

function requireExit(result, label, expected = 0) {
  if (result.status !== expected) {
    const promote = result.status === 4 || result.status === 5 ? result.status : null;
    throw new CheckError(
      `${label}: exit ${result.status}, expected ${expected}${excerpt(result) === '' ? '' : `: ${excerpt(result)}`}`,
      promote,
    );
  }
  return result;
}

function stepById(state, id) {
  return state.steps.find((step) => step.id === id);
}

function eventsOf(root) {
  const runId = readLatest(root).latest_run_id;
  return readEvents(root, runId);
}

function assertNoWrite(before, root, label) {
  const after = snapshotR2c(root);
  const beforeKeys = Object.keys(before);
  const afterKeys = Object.keys(after);
  if (beforeKeys.join('\n') !== afterKeys.join('\n')) {
    throw new Error(`${label}: .r2c file set changed`);
  }
  for (const key of beforeKeys) {
    if (before[key] !== after[key]) throw new Error(`${label}: ${key} changed`);
  }
}

/* ------------------------------------------------------------------ engine */

/** E0: this runtime is on the node floor, and an unsupported one is rejected. */
function nodeFloor(h) {
  return {
    id: 'E0',
    async run() {
      const supported = requireExit(h.run(['--version']), 'E0 supported node');
      if (supported.stdout.trim() !== h.version) {
        throw new Error(`E0: --version printed ${JSON.stringify(supported.stdout)}, expected ${h.version}`);
      }
      const preload = join(h.sandbox, 'node-floor.cjs');
      writeFileSync(
        preload,
        "Object.defineProperty(process.versions, 'node', { value: '23.0.0' });\n",
      );
      const rejected = spawnSyncRetry(process.execPath, ['--require', preload, BIN, '--version'], {
        cwd: h.sandbox,
        env: h.env,
        encoding: 'utf8',
        timeout: 60_000,
        windowsHide: true,
      });
      if (rejected.status === 0) throw new Error('E0: Node 23.0.0 was accepted');
      if (!/unsupported Node\.js 23\.0\.0/.test(rejected.stderr)) {
        throw new Error(`E0: unsupported node was rejected without the floor message: ${rejected.stderr.trim()}`);
      }
      return {
        detail: `node ${process.versions.node} accepted; 23.0.0 rejected (exit ${rejected.status})`,
      };
    },
  };
}

function manifestFiles(root) {
  const files = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.yaml')) files.push(full);
    }
  };
  walk(join(root, 'workflows'));
  return files.sort();
}

function validateManifest(h, manifest) {
  const result = requireExit(
    h.run(['validate', '--manifest', manifest, '--json'], { cwd: h.sandbox }),
    `V1 ${manifest}`,
  );
  const json = envelope(result, `V1 ${manifest}`);
  if (!json.ok) throw new Error(`V1 ${manifest}: envelope is not ok`);
  if (json.data.errors.length !== 0) {
    throw new Error(`V1 ${manifest}: ${json.data.errors.length} error(s)`);
  }
  if (json.data.warnings.length !== 0) {
    throw new Error(`V1 ${manifest}: ${json.data.warnings.length} warning(s)`);
  }
  return json.data;
}

/** V1: the fixture and the repository default manifest both validate. */
function manifestValidate(h) {
  return {
    id: 'V1',
    async run() {
      const root = h.project('v1');
      const fixture = join(root, 'workflows', 'smoke.yaml');
      const fixtureData = validateManifest(h, fixture);
      if (fixtureData.stages !== 2 || fixtureData.steps !== 3) {
        throw new Error(`V1 fixture: expected 2 stages / 3 steps, got ${fixtureData.stages}/${fixtureData.steps}`);
      }
      const defaults = manifestFiles(join(REPO_ROOT, 'pack'));
      for (const manifest of defaults) validateManifest(h, manifest);
      return {
        detail: `fixture 2 stages / 3 steps; default manifest(s) ${defaults.length}`,
      };
    },
  };
}

function walkFiles(root, base = root) {
  const files = [];
  if (!existsSync(root)) return files;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(full, base));
    else if (entry.isFile()) files.push(full.slice(base.length + 1).split('\\').join('/'));
  }
  return files;
}

const PACK_DIRS = ['bin/', 'src/', 'schema/'];
const PACK_ROOT_FILES = new Set(['package.json', 'README.md', 'LICENSE']);
const PACK_FORBIDDEN = ['pack/', 'adapters/', 'plugins/', 'test/', 'docs/', 'scripts/', '.github/'];

/**
 * P1: `npm pack --dry-run --json` ships exactly the declared whitelist.
 * Not part of the 17/15 acceptance faces (ticket #34's CI gate owns it); it is
 * reachable through `r2c acceptance --only P1` so the assertion still has one
 * implementation.
 */
export function packWhitelist() {
  return {
    id: 'P1',
    async run() {
      const npm = process.platform === 'win32'
        ? spawnSyncRetry('npm pack --dry-run --json', undefined, {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          timeout: 180_000,
          shell: true,
          windowsHide: true,
        })
        : spawnSyncRetry('npm', ['pack', '--dry-run', '--json'], {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          timeout: 180_000,
          windowsHide: true,
        });
      if (npm.status !== 0) {
        throw new Error(`P1: npm pack failed: ${excerpt(npm)}`);
      }
      let parsed;
      try {
        parsed = JSON.parse(npm.stdout);
      } catch (error) {
        throw new Error(`P1: npm pack did not emit JSON: ${error.message}`);
      }
      const packed = (Array.isArray(parsed) ? parsed[0]?.files : null) ?? [];
      const paths = new Set(packed.map((file) => String(file.path).split('\\').join('/')));
      for (const path of paths) {
        const allowed = PACK_ROOT_FILES.has(path) || PACK_DIRS.some((dir) => path.startsWith(dir));
        if (!allowed) throw new Error(`P1: unexpected packed path ${path}`);
        const forbidden = PACK_FORBIDDEN.find((prefix) => path.startsWith(prefix));
        if (forbidden !== undefined) throw new Error(`P1: forbidden path ${path} (${forbidden})`);
      }
      for (const required of PACK_ROOT_FILES) {
        if (!paths.has(required)) throw new Error(`P1: missing ${required}`);
      }
      const expected = [];
      for (const dir of ['bin', 'src', 'schema']) {
        for (const rel of walkFiles(join(REPO_ROOT, dir))) expected.push(`${dir}/${rel}`);
      }
      for (const path of expected) {
        if (!paths.has(path)) throw new Error(`P1: declared tree file not packed: ${path}`);
      }
      return { detail: `${paths.size} packed path(s), whitelist exact` };
    },
  };
}

function startRun(h, root, extra = []) {
  const result = requireExit(
    h.run(['run', '--project-root', root, ...extra], { cwd: root }),
    'run',
  );
  if (result.stderr.trim() !== '') throw new Error(`run: unexpected stderr: ${result.stderr.trim()}`);
  const line = submitLine(result.stdout);
  if (line === '') throw new Error('run: plain output has no Submit line');
  return { result, line };
}

/** FS1: a fresh run delivers step-smoke-a with an executable Submit line. */
function firstStep(h) {
  return {
    id: 'FS1',
    async run() {
      const root = h.project('fs1');
      const { result } = startRun(h, root, ['--session-id', SESSION]);
      if (!result.stdout.includes('冒烟第一步')) throw new Error('FS1: step name is missing');
      if (!result.stdout.includes(`--session-id ${SESSION} --step step-smoke-a`)) {
        throw new Error('FS1: Submit line does not target step-smoke-a');
      }
      const view = requireExit(
        h.run(['status', '--project-root', root, '--session-id', SESSION, '--json'], { cwd: root }),
        'FS1 status',
      );
      const json = envelope(view, 'FS1 status');
      if (!RUN_ID.test(json.run_id)) throw new Error(`FS1: bad run id ${json.run_id}`);
      if (json.data.run.current_step_id !== 'step-smoke-a') {
        throw new Error(`FS1: current step is ${json.data.run.current_step_id}`);
      }
      return { detail: `${json.run_id} at step-smoke-a` };
    },
  };
}

/** FS3': execute the exact Submit line printed by FS1. */
function submitLineCheck(h) {
  return {
    id: "FS3'",
    async run() {
      const root = h.project('fs3');
      const { line } = startRun(h, root, ['--session-id', SESSION]);
      artifact(root, 'a.txt');
      const executed = spawnSyncRetry(line, undefined, {
        cwd: root,
        env: h.env,
        encoding: 'utf8',
        timeout: 120_000,
        shell: true,
        windowsHide: true,
      });
      requireExit(executed, 'FS3\' submit line');
      const view = requireExit(
        h.run(['status', '--project-root', root, '--session-id', SESSION, '--json'], { cwd: root }),
        'FS3\' status',
      );
      const json = envelope(view, 'FS3\' status');
      if (json.data.run.current_step_id !== 'step-smoke-b') {
        throw new Error(`FS3': current step is ${json.data.run.current_step_id}, expected step-smoke-b`);
      }
      const events = readEvents(root, json.run_id);
      const submitted = events.some(
        (event) => event.kind === 'step' && event.event === 'submitted' && event.step?.id === 'step-smoke-a',
      );
      const started = events.some(
        (event) => event.kind === 'step' && event.event === 'started' && event.step?.id === 'step-smoke-b',
      );
      if (!submitted || !started) throw new Error('FS3\': submit/start events are missing');
      return { detail: 'Submit line advanced step-smoke-a -> step-smoke-b' };
    },
  };
}

/** FS4: next and hook stop are read-only triggers. */
function triggersReadOnly(h) {
  return {
    id: 'FS4',
    async run() {
      const root = h.project('fs4');
      startRun(h, root, ['--session-id', SESSION]);
      const latest = readLatest(root);
      const runId = latest.latest_run_id;
      const stateBefore = readFileSync(statePath(root, runId), 'utf8');
      const eventsBefore = readFileSync(eventsPath(root, runId), 'utf8');
      const latestBefore = readFileSync(latestPath(root), 'utf8');

      const first = requireExit(
        h.run(['next', '--project-root', root, '--session-id', SESSION, '--format', 'plain'], { cwd: root }),
        'FS4 next #1',
      );
      const second = requireExit(
        h.run(['next', '--project-root', root, '--session-id', SESSION, '--format', 'plain'], { cwd: root }),
        'FS4 next #2',
      );
      if (first.stdout !== second.stdout) throw new Error('FS4: next is not stable across reads');
      if (!first.stdout.includes('冒烟第一步')) throw new Error('FS4: next did not render the active step');

      const stop = requireExit(
        h.run(['hook', 'stop', '--project-root', root, '--session-id', SESSION, '--format', 'json'], { cwd: root }),
        'FS4 hook stop',
      );
      if (envelope(stop, 'FS4 hook stop').decision !== 'block') {
        throw new Error('FS4: hook stop did not deliver');
      }

      const guard = requireExit(
        h.run(['hook', 'pre-tool-use', '--project-root', root, '--session-id', SESSION], {
          cwd: root,
          input: JSON.stringify({
            session_id: SESSION,
            cwd: root,
            tool_name: 'Write',
            tool_input: { file_path: 'docs/a.md' },
          }),
        }),
        'FS4 guard',
      );
      if (guard.stdout.trim() !== '') throw new Error('FS4: ordinary file was denied');

      if (readFileSync(statePath(root, runId), 'utf8') !== stateBefore) throw new Error('FS4: state.json changed');
      if (readFileSync(eventsPath(root, runId), 'utf8') !== eventsBefore) throw new Error('FS4: events changed');
      if (readFileSync(latestPath(root), 'utf8') !== latestBefore) throw new Error('FS4: latest.json changed');
      return { detail: 'next x2 + hook stop + allow guard wrote nothing' };
    },
  };
}

const GOLDEN_STATE = {
  schema: 'r2c.state/v1',
  status: 'completed',
  workflow_id: 'workflow-smoke',
  interaction_mode: 'cli',
  user_input: null,
  current_step_id: null,
  stages: [
    { id: 'stage-smoke-1', name: '阶段一', status: 'completed' },
    { id: 'stage-smoke-2', name: '阶段二', status: 'completed' },
  ],
  steps: [
    {
      id: 'step-smoke-a',
      name: '冒烟第一步',
      stage_id: 'stage-smoke-1',
      skill: null,
      status: 'completed',
      retry_count: 0,
      review_retry_count: 0,
    },
    {
      id: 'step-smoke-b',
      name: '冒烟第二步',
      stage_id: 'stage-smoke-2',
      skill: null,
      status: 'completed',
      retry_count: 0,
      review_retry_count: 0,
    },
    {
      id: 'step-smoke-c',
      name: '冒烟门禁',
      stage_id: 'stage-smoke-2',
      skill: null,
      status: 'completed',
      retry_count: 0,
      review_retry_count: 0,
    },
  ],
};

const GOLDEN_EVENTS = [
  { kind: 'run', event: 'started' },
  { kind: 'step', event: 'started', step: { id: 'step-smoke-a', name: '冒烟第一步' } },
  { kind: 'step', event: 'submitted', step: { id: 'step-smoke-a', name: '冒烟第一步' } },
  { kind: 'step', event: 'started', step: { id: 'step-smoke-b', name: '冒烟第二步' } },
  { kind: 'step', event: 'submitted', step: { id: 'step-smoke-b', name: '冒烟第二步' } },
  { kind: 'step', event: 'started', step: { id: 'step-smoke-c', name: '冒烟门禁' } },
  { kind: 'step', event: 'completed', step: { id: 'step-smoke-c', name: '冒烟门禁' }, exit_code: 0 },
  { kind: 'run', event: 'completed' },
];

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** T2: walk all three steps without a model and compare the normalized state. */
function stateGolden(h) {
  return {
    id: 'T2',
    async run() {
      const root = h.project('t2');
      const started = requireExit(
        h.run(['run', '--project-root', root, '--session-id', SESSION, '--json'], { cwd: root }),
        'T2 run',
      );
      const runJson = envelope(started, 'T2 run');
      const runId = runJson.run_id;

      artifact(root, 'a.txt');
      const firstSubmit = requireExit(
        h.run(
          ['submit', '--project-root', root, '--session-id', SESSION, '--step', 'step-smoke-a', '--json'],
          { cwd: root },
        ),
        'T2 submit a',
      );
      if (envelope(firstSubmit, 'T2 submit a').step?.id !== 'step-smoke-b') {
        throw new Error('T2: step-smoke-a did not advance to step-smoke-b');
      }

      artifact(root, 'b.txt');
      const secondSubmit = requireExit(
        h.run(
          ['submit', '--project-root', root, '--session-id', SESSION, '--step', 'step-smoke-b', '--json'],
          { cwd: root },
        ),
        'T2 submit b',
      );
      const final = envelope(secondSubmit, 'T2 submit b');
      if (final.step !== null || final.data.status !== 'completed') {
        throw new Error(`T2: run did not complete (step ${JSON.stringify(final.step)}, status ${final.data.status})`);
      }

      const normalized = normalizeState(readState(root, runId));
      if (!sameJson(normalized, GOLDEN_STATE)) {
        throw new Error(`T2: normalized state differs: ${JSON.stringify(normalized)}`);
      }
      const normalizedEvents = normalizeEvents(readEvents(root, runId));
      if (!sameJson(normalizedEvents, GOLDEN_EVENTS)) {
        throw new Error(`T2: normalized events differ: ${JSON.stringify(normalizedEvents)}`);
      }
      return { detail: '3 steps completed; state and events match the golden' };
    },
  };
}

/** T4: protected state/manifests deny, ordinary project files allow. */
function writeGuard(h) {
  return {
    id: 'T4',
    async run() {
      const root = h.project('t4');
      startRun(h, root, ['--session-id', SESSION]);
      const state = readLatest(root).latest_run_id;
      if (!RUN_ID.test(state)) throw new Error('T4: run id missing');

      const targets = [
        { path: `.r2c/runs/${state}/state.json`, deny: true },
        { path: 'workflows/smoke.yaml', deny: true },
        { path: 'docs/a.md', deny: false },
      ];
      for (const target of targets) {
        const result = h.run(['hook', 'pre-tool-use', '--project-root', root, '--session-id', SESSION], {
          cwd: root,
          input: JSON.stringify({
            session_id: SESSION,
            cwd: root,
            tool_name: 'Write',
            tool_input: { file_path: target.path },
          }),
        });
        if (target.deny) {
          requireExit(result, `T4 deny ${target.path}`, 2);
          const payload = JSON.parse(result.stdout);
          if (payload.permissionDecision !== 'deny') {
            throw new Error(`T4: ${target.path} did not produce a deny payload`);
          }
        } else {
          requireExit(result, `T4 allow ${target.path}`);
          if (result.stdout.trim() !== '') throw new Error(`T4: ${target.path} produced output`);
        }
      }
      return { detail: 'state/manifest denied; docs allowed' };
    },
  };
}

/* ---------------------------------------------------------------- claiming */

function newProjectWithMintedRun(h, label) {
  const root = h.project(label);
  const started = requireExit(
    h.run(['run', '--project-root', root, '--json'], { cwd: root }),
    `${label} run`,
  );
  const json = envelope(started, `${label} run`);
  if (!RUN_ID.test(json.run_id)) throw new Error(`${label}: bad run id ${json.run_id}`);
  if (json.session_id !== `cli-${json.run_id}`) throw new Error(`${label}: session is not synthetic`);
  return { root, runId: json.run_id, cliSession: json.session_id, json };
}

function hook(h, root, args, input) {
  return h.run(['hook', '--project-root', root, ...args], { cwd: root, input });
}

function statusJson(h, root, sessionId) {
  const result = requireExit(
    h.run(['status', '--project-root', root, '--session-id', sessionId, '--json'], { cwd: root }),
    `status ${sessionId}`,
  );
  return envelope(result, `status ${sessionId}`);
}

function sb1(h) {
  return {
    id: 'SB1',
    async run() {
      const { root, runId, cliSession } = newProjectWithMintedRun(h, 'sb1');
      if (!CLI_SESSION.test(cliSession)) throw new Error('SB1: synthetic id has the wrong grammar');
      const latest = readLatest(root);
      if (!sameJson(latest.runs[cliSession], { active_run_id: runId, latest_run_id: runId })) {
        throw new Error('SB1: latest.json route is wrong');
      }
      const started = requireExit(
        h.run(['run', '--project-root', root, '--json'], { cwd: root }),
        'SB1 second run',
      );
      const second = envelope(started, 'SB1 second run');
      if (second.session_id !== `cli-${second.run_id}`) throw new Error('SB1: second run was not minted');
      const latest2 = readLatest(root);
      if (latest2.runs[second.session_id].active_run_id !== second.run_id) {
        throw new Error('SB1: second route is wrong');
      }
      return { detail: `${runId} minted ${cliSession}` };
    },
  };
}

function sb2(h) {
  return {
    id: 'SB2',
    async run() {
      const { root, runId, cliSession } = newProjectWithMintedRun(h, 'sb2');
      const stop = requireExit(hook(h, root, ['stop', '--session-id', SESSION, '--format', 'json']), 'SB2 stop');
      const block = envelope(stop, 'SB2 stop');
      if (block.decision !== 'block') throw new Error('SB2: stop was not a block');
      if (!block.reason.includes(`submit --session-id ${SESSION} --step step-smoke-a`)) {
        throw new Error('SB2: reason does not carry the claimed Submit line');
      }
      const view = statusJson(h, root, SESSION);
      if (view.run_id !== runId) throw new Error('SB2: status routed to another run');
      if (view.data.run.session_id !== SESSION) throw new Error('SB2: session_id was not rewritten');
      const claimed = claims(readEvents(root, runId));
      if (claimed.length !== 1) throw new Error(`SB2: ${claimed.length} claimed events`);
      if (!sameJson(claimed[0].session, { from: cliSession, to: SESSION })) {
        throw new Error('SB2: claimed session payload is wrong');
      }
      const latest = readLatest(root);
      if (!sameJson(Object.keys(latest.runs), [SESSION])) throw new Error('SB2: stale cli route remains');
      if (latest.runs[SESSION].active_run_id !== runId) throw new Error('SB2: claimed route is wrong');
      return { detail: 'claimed by the unique structural candidate' };
    },
  };
}

function sb3(h) {
  return {
    id: 'SB3',
    async run() {
      const { root, runId } = newProjectWithMintedRun(h, 'sb3');
      requireExit(hook(h, root, ['stop', '--session-id', SESSION, '--format', 'json']), 'SB3 first stop');
      const stateBefore = readState(root, runId);
      const eventsBefore = readFileSync(eventsPath(root, runId), 'utf8');
      const second = requireExit(hook(h, root, ['stop', '--session-id', SESSION_2, '--format', 'json']), 'SB3 second stop');
      if (second.stdout !== '') throw new Error('SB3: second session got stdout');
      const missing = h.run(['status', '--project-root', root, '--session-id', SESSION_2, '--json'], { cwd: root });
      if (missing.status !== 4) throw new Error(`SB3: second session status exited ${missing.status}`);
      if (!sameJson(readState(root, runId), stateBefore)) throw new Error('SB3: state changed');
      if (readFileSync(eventsPath(root, runId), 'utf8') !== eventsBefore) throw new Error('SB3: events changed');
      if (claims(readEvents(root, runId)).length !== 1) throw new Error('SB3: claim count changed');
      return { detail: 'second real session was refused without writes' };
    },
  };
}

function sb4(h) {
  return {
    id: 'SB4',
    async run() {
      const root = h.project('sb4');
      const first = envelope(
        requireExit(h.run(['run', '--project-root', root, '--json'], { cwd: root }), 'SB4 run 1'),
        'SB4 run 1',
      );
      const second = envelope(
        requireExit(h.run(['run', '--project-root', root, '--json'], { cwd: root }), 'SB4 run 2'),
        'SB4 run 2',
      );
      const before = snapshotR2c(root);
      const stop = requireExit(hook(h, root, ['stop', '--session-id', SESSION]), 'SB4 ambiguous stop');
      if (stop.stdout !== '') throw new Error('SB4: ambiguous stop wrote stdout');
      const lines = stop.stderr.split(/\r?\n/).filter(Boolean);
      if (lines.length !== 1 || !/ambiguous/.test(lines[0])) {
        throw new Error(`SB4: expected one ambiguous stderr line, got ${JSON.stringify(stop.stderr)}`);
      }
      for (const runId of [first.run_id, second.run_id]) {
        if (readState(root, runId).session_id !== `cli-${runId}`) throw new Error('SB4: a run was claimed');
        if (claims(readEvents(root, runId)).length !== 0) throw new Error('SB4: claimed event exists');
      }
      if (readLatest(root).runs[SESSION] !== undefined) throw new Error('SB4: latest routed to the caller');
      assertNoWrite(before, root, 'SB4');

      // 4b: two distinct workflows, the filter selects exactly one.
      const filtered = h.project('sb4-filtered');
      const a = envelope(
        requireExit(h.run(['run', '--project-root', filtered, '--json'], { cwd: filtered }), 'SB4b run a'),
        'SB4b run a',
      );
      const other = join(filtered, 'other', 'smoke.yaml');
      mkdirSync(join(filtered, 'other'), { recursive: true });
      const text = readFileSync(join(FIXTURE_DIR, 'smoke.yaml'), 'utf8');
      writeFileSync(
        other,
        text.replace('id: workflow-smoke', 'id: workflow-smoke-other'),
        { flag: 'w' },
      );
      const b = envelope(
        requireExit(
          h.run(['run', '--project-root', filtered, '--manifest', other, '--json'], { cwd: filtered }),
          'SB4b run b',
        ),
        'SB4b run b',
      );
      if (a.data.workflow_id === b.data.workflow_id) throw new Error('SB4b: workflows are not distinct');
      const pinned = requireExit(
        hook(h, filtered, [
          'stop',
          '--session-id',
          SESSION,
          '--workflow',
          a.data.workflow_id,
          '--format',
          'json',
        ]),
        'SB4b pinned stop',
      );
      const block = envelope(pinned, 'SB4b pinned stop');
      if (block.decision !== 'block') throw new Error('SB4b: pinned stop did not deliver');
      if (readState(filtered, a.run_id).session_id !== SESSION) throw new Error('SB4b: A was not claimed');
      if (readState(filtered, b.run_id).session_id !== `cli-${b.run_id}`) throw new Error('SB4b: B was claimed');
      return { detail: 'ambiguity is silent; --workflow pins the candidate' };
    },
  };
}

function sb5(h) {
  return {
    id: 'SB5',
    async run() {
      const root = h.project('sb5');
      const explicit = envelope(
        requireExit(
          h.run(['run', '--project-root', root, '--session-id', SESSION_2, '--json'], { cwd: root }),
          'SB5 explicit run',
        ),
        'SB5 explicit run',
      );
      const before = snapshotR2c(root);
      const noCandidate = requireExit(hook(h, root, ['stop', '--session-id', SESSION]), 'SB5 no candidate');
      if (noCandidate.stdout !== '') throw new Error('SB5: zero candidates wrote stdout');
      const noSid = requireExit(hook(h, root, ['stop']), 'SB5 no sid');
      if (noSid.stdout !== '') throw new Error('SB5: missing sid wrote stdout');
      const guard = requireExit(
        hook(h, root, ['pre-tool-use', '--session-id', SESSION], JSON.stringify({
          session_id: SESSION,
          cwd: root,
          tool_name: 'Write',
          tool_input: { file_path: 'docs/a.md' },
        })),
        'SB5 guard',
      );
      if (guard.stdout.trim() !== '') throw new Error('SB5: ordinary write was denied');
      const synthetic = requireExit(
        hook(h, root, ['stop', '--session-id', `cli-${explicit.run_id}`]),
        'SB5 synthetic sid',
      );
      if (synthetic.stdout !== '') throw new Error('SB5: synthetic sid wrote stdout');
      assertNoWrite(before, root, 'SB5');
      return { detail: 'zero candidates, missing sid, synthetic sid and guards wrote nothing' };
    },
  };
}

function sb6(h) {
  return {
    id: 'SB6',
    async run() {
      const root = h.project('sb6');
      const a = envelope(
        requireExit(
          h.run(['run', '--project-root', root, '--session-id', SESSION_2, '--json'], { cwd: root }),
          'SB6 run A',
        ),
        'SB6 run A',
      );
      const b = envelope(
        requireExit(h.run(['run', '--project-root', root, '--json'], { cwd: root }), 'SB6 run B'),
        'SB6 run B',
      );
      const stop = requireExit(hook(h, root, ['stop', '--session-id', SESSION, '--format', 'json']), 'SB6 stop');
      if (envelope(stop, 'SB6 stop').decision !== 'block') throw new Error('SB6: stop did not deliver');
      if (readState(root, b.run_id).session_id !== SESSION) throw new Error('SB6: B was not claimed');
      if (readState(root, a.run_id).session_id !== SESSION_2) throw new Error('SB6: A changed');
      const latest = readLatest(root);
      if (latest.runs[SESSION_2].active_run_id !== a.run_id) throw new Error('SB6: A route changed');
      if (claims(readEvents(root, a.run_id)).length !== 0) throw new Error('SB6: A got a claim');
      if (claims(readEvents(root, b.run_id)).length !== 1) throw new Error('SB6: B claim count is wrong');
      if (statusJson(h, root, SESSION_2).run_id !== a.run_id) throw new Error('SB6: A status moved');
      return { detail: 'only the synthetic run was claimed' };
    },
  };
}

function sb7(h) {
  return {
    id: 'SB7',
    async run() {
      const { root, runId } = newProjectWithMintedRun(h, 'sb7');
      const results = await Promise.all([
        h.runAsync(['hook', 'stop', '--project-root', root, '--session-id', SESSION], { cwd: root }),
        h.runAsync(['hook', 'stop', '--project-root', root, '--session-id', SESSION_2], { cwd: root }),
      ]);
      const claimed = claims(readEvents(root, runId));
      if (claimed.length !== 1) throw new Error(`SB7: ${claimed.length} concurrent claims`);
      const latest = readLatest(root);
      const winners = Object.keys(latest.runs).filter((key) => !key.startsWith('cli-'));
      if (winners.length !== 1) throw new Error(`SB7: ${winners.length} non-cli routes`);
      if (latest.runs[winners[0]].active_run_id !== runId) throw new Error('SB7: winner route is wrong');
      for (const result of results) {
        if (result.status !== null && ![0, 5].includes(result.status)) {
          throw new Error(`SB7: concurrent stop exited ${result.status}`);
        }
        if (result.status === 5 && result.stdout !== '') throw new Error('SB7: lock loser wrote stdout');
        if (result.status === 0 && result.stdout !== '' && !result.stdout.includes(`--session-id ${winners[0]}`)) {
          throw new Error('SB7: winner delivered the wrong session');
        }
      }
      return { detail: 'two concurrent stops claim exactly once' };
    },
  };
}

function sb8(h) {
  return {
    id: 'SB8',
    async run() {
      const { root, runId, cliSession } = newProjectWithMintedRun(h, 'sb8');
      requireExit(hook(h, root, ['stop', '--session-id', SESSION]), 'SB8 claim');
      const stateBefore = readState(root, runId);
      const eventsBefore = readFileSync(eventsPath(root, runId), 'utf8');
      const latestBefore = readFileSync(latestPath(root), 'utf8');
      const stale = h.run(
        ['submit', '--project-root', root, '--session-id', cliSession, '--step', 'step-smoke-a', '--json'],
        { cwd: root },
      );
      if (stale.status !== 2) throw new Error(`SB8: stale submit exited ${stale.status}, expected 2`);
      const json = envelope(stale, 'SB8 stale submit');
      if (json.error?.code !== 'RUN_CLAIMED') throw new Error(`SB8: error ${json.error?.code}`);
      if (!sameJson(readState(root, runId), stateBefore)) throw new Error('SB8: state changed');
      if (readFileSync(eventsPath(root, runId), 'utf8') !== eventsBefore) throw new Error('SB8: events changed');
      if (readFileSync(latestPath(root), 'utf8') !== latestBefore) throw new Error('SB8: latest changed');
      return { detail: 'stale cli sid exits 2 RUN_CLAIMED without writes' };
    },
  };
}

function sb9(h) {
  return {
    id: 'SB9',
    async run() {
      const { root, runId, cliSession } = newProjectWithMintedRun(h, 'sb9');
      requireExit(
        h.run(['pause', '--project-root', root, '--session-id', cliSession], { cwd: root }),
        'SB9 pause',
      );
      const pausedStop = requireExit(hook(h, root, ['stop', '--session-id', SESSION, '--format', 'json']), 'SB9 paused stop');
      if (pausedStop.stdout !== '') throw new Error('SB9: paused run was delivered');
      if (claims(readEvents(root, runId)).length !== 0) throw new Error('SB9: paused run was claimed');
      requireExit(
        h.run(['resume', '--project-root', root, '--session-id', cliSession], { cwd: root }),
        'SB9 resume',
      );
      const resumedStop = requireExit(hook(h, root, ['stop', '--session-id', SESSION, '--format', 'json']), 'SB9 resumed stop');
      if (envelope(resumedStop, 'SB9 resumed stop').decision !== 'block') {
        throw new Error('SB9: resumed run was not claimed');
      }
      if (claims(readEvents(root, runId)).length !== 1) throw new Error('SB9: claim count is wrong');
      return { detail: 'paused is not a candidate; resume restores it' };
    },
  };
}

function sb10(h) {
  return {
    id: 'SB10',
    async run() {
      const { root, runId, cliSession } = newProjectWithMintedRun(h, 'sb10');
      requireExit(hook(h, root, ['stop', '--session-id', SESSION]), 'SB10 claim');
      const claimsBefore = claims(readEvents(root, runId)).length;
      const drifted = readState(root, runId);
      drifted.session_id = cliSession;
      writeState(root, runId, drifted);
      const latest = readLatest(root);
      latest.runs[cliSession] = { ...latest.runs[SESSION] };
      writeFileSync(latestPath(root), `${JSON.stringify(latest, null, 2)}\n`);
      artifact(root, 'a.txt');
      const submitted = requireExit(
        h.run(
          ['submit', '--project-root', root, '--session-id', SESSION, '--step', 'step-smoke-a', '--json'],
          { cwd: root },
        ),
        'SB10 submit',
      );
      envelope(submitted, 'SB10 submit');
      if (!/repaired/i.test(submitted.stderr)) throw new Error('SB10: no repair warning');
      if (readState(root, runId).session_id !== SESSION) throw new Error('SB10: state was not repaired');
      const repaired = readLatest(root);
      if (repaired.runs[cliSession] !== undefined) throw new Error('SB10: cli route remains');
      if (repaired.runs[SESSION].active_run_id !== runId) throw new Error('SB10: real route is wrong');
      if (claims(readEvents(root, runId)).length !== claimsBefore) throw new Error('SB10: repair appended a claim');
      return { detail: 'replay rebuilt session and latest routes without a new event' };
    },
  };
}

/* ------------------------------------------------------------------- agent */

function receiptCandidates(h, agentId) {
  return [
    join(h.installRoot, '.r2c', 'install', `${agentId}.json`),
    join(h.home, '.r2c', 'install', `${agentId}.json`),
  ];
}

function installedReceipt(h, agentId) {
  return receiptCandidates(h, agentId).find((file) => existsSync(file)) ?? null;
}

function installArgs(h, agentId, payloadSource) {
  const args = ['adapter', 'install', agentId, '--project-root', h.installRoot, '--json'];
  if (payloadSource !== null) args.push('--from', payloadSource);
  if (agentId === 'dsh') args.push('--scope', 'user', '--profile', 'web');
  return args;
}

function installCheck(h, agentId, payloadSource, state) {
  return {
    id: 'I1',
    async run() {
      const result = h.run(installArgs(h, agentId, payloadSource), { cwd: h.installRoot });
      if (result.status !== 0) {
        let code = null;
        try {
          code = JSON.parse(result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1))?.error?.code ?? null;
        } catch {
          code = null;
        }
        const promote = result.status === 5
          ? 5
          : result.status === 4
            || ['UNKNOWN_ADAPTER', 'AGENT_NOT_DETECTED', 'PAYLOAD_NOT_FOUND'].includes(code)
            ? 4
            : null;
        throw new CheckError(
          `I1 install: exit ${result.status}${code === null ? '' : ` ${code}`}`,
          promote,
        );
      }
      const json = envelope(result, 'I1 install');
      const data = json.data;
      if (!['installed', 'upgraded', 'noop'].includes(data.action)) {
        throw new Error(`I1: unexpected action ${data.action}`);
      }
      if (data.action !== 'noop' && data.changed !== true) throw new Error('I1: action changed but changed=false');
      if (typeof data.payload_home !== 'string' || data.payload_home === '') {
        throw new Error('I1: payload_home is missing');
      }
      state.scope = data.scope;
      state.payloadHome = data.payload_home;
      state.receipt = installedReceipt(h, agentId);
      if (state.receipt === null) throw new Error('I1: receipt was not written');
      if (data.files.some((file) => file.kind !== 'link' && typeof file.sha256 !== 'string')) {
        throw new Error('I1: a changed file has no sha256');
      }
      return { detail: `${data.action} (${state.scope}), ${data.files.length} file(s) changed` };
    },
  };
}

function idempotentCheck(h, agentId, payloadSource) {
  return {
    id: 'I2',
    async run() {
      const result = h.run(installArgs(h, agentId, payloadSource), { cwd: h.installRoot });
      requireExit(result, 'I2 install');
      const data = envelope(result, 'I2 install').data;
      if (data.action !== 'noop' || data.changed !== false) {
        throw new Error(`I2: second install is ${data.action}/changed=${data.changed}`);
      }
      if (data.files.length !== 0) throw new Error(`I2: ${data.files.length} file(s) rewritten`);
      return { detail: 'second install is a zero-write noop' };
    },
  };
}

function doctorCheck(h, agentId) {
  return {
    id: 'I3',
    async run() {
      const result = h.run(
        ['adapter', 'doctor', agentId, '--project-root', h.installRoot, '--json'],
        { cwd: h.installRoot },
      );
      if (result.status !== 0) {
        let failed = [];
        try {
          const parsed = JSON.parse(result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1));
          failed = (parsed.data?.checks ?? [])
            .filter((check) => check.status === 'fail')
            .map((check) => check.name);
        } catch {
          failed = [];
        }
        throw new CheckError(
          `I3 doctor: exit ${result.status}${failed.length === 0 ? '' : `: ${failed.join(', ')}`}`,
          result.status === 4 ? 4 : null,
        );
      }
      const checks = envelope(result, 'I3 doctor').data.checks;
      const failed = checks.filter((check) => check.status === 'fail');
      if (failed.length > 0) {
        throw new Error(`I3: doctor failed: ${failed.map((check) => check.name).join(', ')}`);
      }
      const names = new Set(checks.map((check) => check.name));
      for (const required of ['engine.version', 'receipt.files', 'hooks.wired', 'discovery']) {
        if (!names.has(required)) throw new Error(`I3: missing doctor check ${required}`);
      }
      return { detail: `${checks.length} doctor checks, no fail` };
    },
  };
}

const DISCOVERY = {
  'claude-code': { dir: ['.claude', 'commands'], suffix: '.md' },
  codex: { dir: ['.agents', 'skills'], suffix: 'SKILL.md' },
  omp: { dir: ['.omp', 'commands'], suffix: '.md' },
  opencode: { dir: ['.opencode', 'commands'], suffix: '.md' },
};

function discoveryCheck(h, agentId, state) {
  return {
    id: 'I4',
    async run() {
      if (agentId === 'dsh') {
        if (state.payloadHome === null) throw new Error('I4: dsh has no payload home');
        const commands = readdirSync(join(state.payloadHome, 'commands'))
          .filter((name) => /^r2c-[a-z0-9-]+\.md$/.test(name))
          .map((name) => name.slice(0, -3))
          .sort();
        if (!sameJson(commands, [...COMMAND_IDS].sort())) {
          throw new Error(`I4: dsh commands are ${JSON.stringify(commands)}`);
        }
        const plugin = join(state.payloadHome, 'adapters', 'dsh', 'index.mjs');
        if (!existsSync(plugin) || !/\.register\s*\(/.test(readFileSync(plugin, 'utf8'))) {
          throw new Error('I4: dsh plugin does not register commands');
        }
        if (!existsSync(join(state.payloadHome, 'adapters', 'dsh', 'cordis.patch.yml'))) {
          throw new Error('I4: dsh bundle patch is missing');
        }
        return { detail: '7 commands + command-registering dsh bundle' };
      }
      const spec = DISCOVERY[agentId];
      if (spec === undefined) throw new Error(`I4: no discovery spec for ${agentId}`);
      const dir = join(h.installRoot, ...spec.dir);
      if (!existsSync(dir)) throw new Error(`I4: discovery directory is missing: ${dir}`);
      const found = [];
      if (agentId === 'codex') {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isDirectory() || !COMMAND_IDS.includes(entry.name)) continue;
          if (existsSync(join(dir, entry.name, 'SKILL.md'))) found.push(entry.name);
        }
      } else {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith(spec.suffix)) continue;
          found.push(entry.name.slice(0, -spec.suffix.length));
        }
      }
      found.sort();
      if (!sameJson(found, [...COMMAND_IDS].sort())) {
        throw new Error(`I4: discovered ${JSON.stringify(found)}`);
      }
      if (found.length !== 7) throw new Error(`I4: ${found.length} entries discovered`);
      return { detail: `7 entry points under ${spec.dir.join('/')}` };
    },
  };
}

function smokeCheck(h, agentId) {
  return {
    id: 'I5',
    async run() {
      const result = h.run(
        ['adapter', 'smoke', agentId, '--project-root', h.installRoot, '--json'],
        { cwd: h.installRoot },
      );
      requireExit(result, 'I5 smoke');
      const data = envelope(result, 'I5 smoke').data;
      if (data.ok !== true) throw new Error(`I5: smoke reported ok=${data.ok}`);
      if (data.available === false) throw new Error('I5: smoke.mjs is unavailable');
      return { detail: `discovery ${data.ok ? 'pass' : 'fail'}${data.detail ? ` (${data.detail})` : ''}` };
    },
  };
}

function deliveredTextCheck(h, agentId) {
  return {
    id: 'T1',
    async run() {
      const root = h.project('t1');
      startRun(h, root, ['--session-id', SESSION]);
      const runner = `node ${BIN}`;
      const next = requireExit(
        h.run(
          ['next', '--project-root', root, '--session-id', SESSION, '--format', 'plain', '--runner-cmd', runner],
          { cwd: root },
        ),
        'T1 next',
      );
      const shim = h.shim(
        [
          '--event',
          'stop',
          '--agent',
          agentId,
          '--format',
          'json',
          '--runner-cmd',
          runner,
          '--project-root',
          root,
          '--session-id',
          SESSION,
        ],
        { cwd: root, input: JSON.stringify({ session_id: SESSION, cwd: root }) },
      );
      requireExit(shim, 'T1 shim');
      const block = envelope(shim, 'T1 shim');
      if (block.decision !== 'block') throw new Error('T1: shim did not block');
      if (block.reason.trimEnd() !== next.stdout.trimEnd()) {
        throw new Error('T1: shim text differs from next --format plain');
      }
      return { detail: 'shim reason equals next --format plain' };
    },
  };
}

function uninstallCheck(h, agentId, payloadSource) {
  return {
    id: 'U1',
    async run() {
      const result = h.run(
        ['adapter', 'uninstall', agentId, '--project-root', h.installRoot, '--json'],
        { cwd: h.installRoot },
      );
      requireExit(result, 'U1 uninstall');
      const data = envelope(result, 'U1 uninstall').data;
      if (data.action !== 'removed') throw new Error(`U1: action ${data.action}`);
      const declared = payloadSource === null
        ? null
        : readJsonIfExists(join(payloadSource, 'adapters', agentId, 'adapter.json'))?.manualSteps ?? null;
      for (const item of data.leftover) {
        if (item.startsWith('manual:')) {
          if (declared !== null && !declared.includes(item.slice('manual:'.length))) {
            throw new Error(`U1: undeclared leftover ${item}`);
          }
          continue;
        }
        if (agentId === 'dsh' && item.startsWith('node_modules:')) continue;
        throw new Error(`U1: undeclared leftover ${item}`);
      }
      if (installedReceipt(h, agentId) !== null) throw new Error('U1: receipt survived');
      return { detail: `removed; ${data.leftover.length} declared leftover(s)` };
    },
  };
}

function secondUninstallCheck(h, agentId) {
  return {
    id: 'U2',
    async run() {
      const result = h.run(
        ['adapter', 'uninstall', agentId, '--project-root', h.installRoot, '--json'],
        { cwd: h.installRoot },
      );
      if (result.status !== 4) throw new Error(`U2: second uninstall exited ${result.status}, expected 4`);
      const json = envelope(result, 'U2 uninstall');
      if (json.error?.code !== 'NOT_INSTALLED') throw new Error(`U2: error ${json.error?.code}`);
      return { detail: 'second uninstall exits 4 NOT_INSTALLED' };
    },
  };
}

/* ---------------------------------------------------------------- assembly */

export function coreChecks(h) {
  return [
    nodeFloor(h),
    manifestValidate(h),
    firstStep(h),
    submitLineCheck(h),
    triggersReadOnly(h),
    stateGolden(h),
    writeGuard(h),
  ];
}

export function claimChecks(h) {
  return [
    sb1(h),
    sb2(h),
    sb3(h),
    sb4(h),
    sb5(h),
    sb6(h),
    sb7(h),
    sb8(h),
    sb9(h),
    sb10(h),
  ];
}

export function engineChecks(h) {
  return [...coreChecks(h), ...claimChecks(h)];
}

export function agentChecks(h, agentId, payloadSource) {
  const state = { scope: null, payloadHome: null, receipt: null };
  return [
    installCheck(h, agentId, payloadSource, state),
    idempotentCheck(h, agentId, payloadSource),
    doctorCheck(h, agentId),
    discoveryCheck(h, agentId, state),
    smokeCheck(h, agentId),
    deliveredTextCheck(h, agentId),
    uninstallCheck(h, agentId, payloadSource),
    secondUninstallCheck(h, agentId),
  ];
}

export function allCheckIds() {
  return [
    'E0',
    'V1',
    'P1',
    'FS1',
    "FS3'",
    'FS4',
    'T1',
    'T2',
    'T4',
    'I1',
    'I2',
    'I3',
    'I4',
    'I5',
    'U1',
    'U2',
    ...Array.from({ length: 10 }, (_, index) => `SB${index + 1}`),
  ];
}
