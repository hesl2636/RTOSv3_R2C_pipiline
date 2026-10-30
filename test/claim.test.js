import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { TWO_STEP_YAML, writeTwoStepProject } from './helpers/two-step.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(REPO, 'bin', 'r2c.js');
const CLI_SID = /^cli-R\d{8}T\d{6}Z-[0-9a-f]{6}$/;
const RUN_ID = /^R\d{8}T\d{6}Z-[0-9a-f]{6}$/;
const S = '01a181f0-00a9-7606-9db4-7eccaedcc245';
const S2 = '01a181f0-00a9-7606-9db4-7eccaedcc246';

function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.R2C_SESSION_ID;
  delete env.R2C_PROJECT_ROOT;
  return env;
}

function cli(args, { cwd, env, input } = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: cleanEnv(env),
    input,
  });
}

function cliAsync(args, { cwd, env } = {}) {
  return new Promise((settle) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd,
      env: cleanEnv(env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => settle({ status, stdout, stderr }));
  });
}

/** One JSON envelope line, asserted. */
function envelope(result) {
  const lines = result.stdout.split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1, `expected one JSON line, got ${JSON.stringify(result.stdout)}`);
  return JSON.parse(lines[0]);
}

function tempProject(t) {
  const root = mkdtempSync(join(tmpdir(), 'r2c-claim-project-'));
  const home = join(root, 'home');
  mkdirSync(join(home, '.dsh'), { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeTwoStepProject(root);
  const env = {
    HOME: home,
    USERPROFILE: home,
    DSH_HOME: join(home, '.dsh'),
  };
  return { root, home, env };
}

function runCmd(project, args = []) {
  return cli(['run', '--project-root', project.root, ...args], {
    cwd: project.root,
    env: project.env,
  });
}

function hook(project, args) {
  return cli(['hook', ...args, '--project-root', project.root], {
    cwd: project.root,
    env: project.env,
  });
}

function status(project, sessionId) {
  return cli(['status', '--project-root', project.root, '--session-id', sessionId, '--json'], {
    cwd: project.root,
    env: project.env,
  });
}

function submit(project, sessionId, step) {
  return cli(
    ['submit', '--project-root', project.root, '--session-id', sessionId, '--step', step, '--json'],
    { cwd: project.root, env: project.env },
  );
}

function runJson(project, args = []) {
  const result = runCmd(project, [...args, '--json']);
  assert.equal(result.status, 0, result.stderr);
  return { result, envelope: envelope(result) };
}

function stateFile(root, runId) {
  return join(root, '.r2c', 'runs', runId, 'state.json');
}

function eventsFile(root, runId) {
  return join(root, '.r2c', 'runs', runId, 'events.jsonl');
}

function readState(root, runId) {
  return JSON.parse(readFileSync(stateFile(root, runId), 'utf8'));
}

function writeState(root, runId, state) {
  writeFileSync(stateFile(root, runId), `${JSON.stringify(state, null, 2)}\n`);
}

function readEvents(root, runId) {
  return readFileSync(eventsFile(root, runId), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

function readLatest(root) {
  return JSON.parse(readFileSync(join(root, '.r2c', 'latest.json'), 'utf8'));
}

function claimed(root, runId) {
  return readEvents(root, runId).filter(
    (event) => event.kind === 'run' && event.event === 'claimed',
  );
}

/** Every file under `.r2c`, keyed by relative path, as raw bytes. */
function snapshot(root) {
  const files = {};
  const base = join(root, '.r2c');
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      const file = join(dir, name);
      const info = statSync(file);
      if (info.isDirectory()) walk(file);
      else files[relative(base, file)] = readFileSync(file).toString('base64');
    }
  };
  walk(base);
  return files;
}

/** State with the fields a claim or repair is allowed to touch removed. */
function stableState(state) {
  const copy = structuredClone(state);
  delete copy.session_id;
  delete copy.updated_at;
  return copy;
}

function submitLine(text) {
  return text.split(/\r?\n/).find((line) => line.includes(' submit --session-id ')) ?? '';
}

test('SB1 run mints cli-<runId>, routes it in latest.json and renders it', (t) => {
  const project = tempProject(t);
  const plain = runCmd(project);
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(plain.stderr, '');
  const line = submitLine(plain.stdout);
  assert.ok(line, 'plain output is missing the submit line');
  const sid = /--session-id (\S+)/.exec(line)[1];
  assert.match(sid, CLI_SID);
  const runId = sid.slice('cli-'.length);
  assert.match(runId, RUN_ID);
  assert.match(line, /--step step-a$/);
  assert.match(plain.stdout, new RegExp(`cli-${runId}`));

  let latest = readLatest(project.root);
  assert.deepEqual(latest.runs[sid], { active_run_id: runId, latest_run_id: runId });
  assert.equal(readState(project.root, runId).session_id, sid);

  const second = runJson(project);
  const env = second.envelope;
  assert.match(env.run_id, RUN_ID);
  assert.equal(env.session_id, `cli-${env.run_id}`);
  assert.match(env.session_id, CLI_SID);
  latest = readLatest(project.root);
  assert.equal(latest.runs[env.session_id].active_run_id, env.run_id);
});

test('SB2 the first stop by a real session claims the only candidate', (t) => {
  const project = tempProject(t);
  const { envelope: started, result } = runJson(project);
  assert.equal(result.status, 0, result.stderr);
  const runId = started.run_id;
  const cliSid = `cli-${runId}`;
  const before = readState(project.root, runId);

  const stop = hook(project, ['stop', '--session-id', S, '--format', 'json']);
  assert.equal(stop.status, 0, stop.stderr);
  assert.equal(stop.stderr, '');
  const block = envelope(stop);
  assert.equal(block.decision, 'block');
  assert.match(block.reason, new RegExp(`submit --session-id ${S} --step step-a`));

  const view = status(project, S);
  assert.equal(view.status, 0, view.stderr);
  const statusEnvelope = envelope(view);
  assert.equal(statusEnvelope.run_id, runId);
  assert.equal(statusEnvelope.data.run.session_id, S);

  const claims = claimed(project.root, runId);
  assert.equal(claims.length, 1);
  assert.deepEqual(claims[0].session, { from: cliSid, to: S });

  const latest = readLatest(project.root);
  assert.deepEqual(Object.keys(latest.runs), [S]);
  assert.equal(latest.runs[S].active_run_id, runId);
  assert.equal(latest.runs[S].latest_run_id, runId);

  const after = readState(project.root, runId);
  assert.equal(after.session_id, S);
  assert.notEqual(after.updated_at, before.updated_at);
  assert.deepEqual(stableState(after), stableState(before));
});

test('SB3 a second session cannot steal a claimed run', (t) => {
  const project = tempProject(t);
  const { envelope: started } = runJson(project);
  const runId = started.run_id;

  const first = hook(project, ['stop', '--session-id', S, '--format', 'json']);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(envelope(first).decision, 'block');

  const beforeStop = snapshot(project.root);
  const beforeState = readState(project.root, runId);

  const second = hook(project, ['stop', '--session-id', S2, '--format', 'json']);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout, '');
  assert.equal(second.stderr, '');

  assert.equal(status(project, S2).status, 4);
  assert.deepEqual(readState(project.root, runId), beforeState);
  assert.deepEqual(snapshot(project.root), beforeStop);
  assert.equal(claimed(project.root, runId).length, 1);
});

test('SB4 multiple candidates are never guessed; --workflow narrows the choice', (t) => {
  const project = tempProject(t);
  const first = runJson(project);
  const second = runJson(project);
  const runIds = [first.envelope.run_id, second.envelope.run_id];

  const before = snapshot(project.root);
  const stop = hook(project, ['stop', '--session-id', S]);
  assert.equal(stop.status, 0, stop.stderr);
  assert.equal(stop.stdout, '');
  const lines = stop.stderr.split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1, JSON.stringify(stop.stderr));
  assert.match(lines[0], /ambiguous/);

  for (const runId of runIds) {
    assert.equal(readState(project.root, runId).session_id, `cli-${runId}`);
    assert.equal(claimed(project.root, runId).length, 0);
  }
  assert.equal(readLatest(project.root).runs[S], undefined);
  assert.deepEqual(snapshot(project.root), before);

  // 4b: two candidates from different workflows; the filter picks one.
  const otherProject = tempProject(t);
  const a = runJson(otherProject).envelope;
  const otherManifest = join(otherProject.root, 'other', 'other.yaml');
  mkdirSync(join(otherProject.root, 'other'), { recursive: true });
  const otherManifestYaml = TWO_STEP_YAML.replace('id: workflow-two-step', 'id: workflow-other');
  writeFileSync(otherManifest, otherManifestYaml);
  const b = runJson(otherProject, ['--manifest', otherManifest]).envelope;
  assert.equal(a.data.workflow_id, 'workflow-two-step');
  assert.equal(b.data.workflow_id, 'workflow-other');

  const pinned = hook(otherProject, [
    'stop',
    '--session-id',
    S,
    '--workflow',
    'workflow-two-step',
    '--format',
    'json',
  ]);
  assert.equal(pinned.status, 0, pinned.stderr);
  const block = envelope(pinned);
  assert.equal(block.decision, 'block');
  assert.match(block.reason, new RegExp(`submit --session-id ${S} --step step-a`));
  assert.equal(readState(otherProject.root, a.run_id).session_id, S);
  assert.equal(readState(otherProject.root, b.run_id).session_id, `cli-${b.run_id}`);
  assert.equal(claimed(otherProject.root, a.run_id).length, 1);
  assert.equal(claimed(otherProject.root, b.run_id).length, 0);
});

test('SB5 zero candidates and synthetic ids are silent and write nothing', (t) => {
  const project = tempProject(t);
  const explicit = runJson(project, ['--session-id', S2]).envelope;
  const before = snapshot(project.root);

  const noCandidate = hook(project, ['stop', '--session-id', S]);
  assert.equal(noCandidate.status, 0, noCandidate.stderr);
  assert.equal(noCandidate.stdout, '');

  const noSid = hook(project, ['stop']);
  assert.equal(noSid.status, 0, noSid.stderr);
  assert.equal(noSid.stdout, '');

  const guard = cli(
    ['hook', 'pre-tool-use', '--project-root', project.root, '--session-id', S],
    {
      cwd: project.root,
      env: project.env,
      input: JSON.stringify({
        session_id: S,
        cwd: project.root,
        tool_name: 'Write',
        tool_input: { file_path: 'docs/a.md' },
      }),
    },
  );
  assert.equal(guard.status, 0, guard.stderr);
  assert.equal(guard.stdout, '');

  const synthetic = hook(project, ['stop', '--session-id', `cli-${explicit.run_id}`]);
  assert.equal(synthetic.status, 0, synthetic.stderr);
  assert.equal(synthetic.stdout, '');

  assert.deepEqual(snapshot(project.root), before);
});

test('SB6 claiming one run never touches another real session', (t) => {
  const project = tempProject(t);
  const a = runJson(project, ['--session-id', S2]).envelope;
  const b = runJson(project).envelope;

  const stop = hook(project, ['stop', '--session-id', S, '--format', 'json']);
  assert.equal(stop.status, 0, stop.stderr);
  assert.equal(envelope(stop).decision, 'block');

  assert.equal(readState(project.root, b.run_id).session_id, S);
  assert.equal(readState(project.root, a.run_id).session_id, S2);
  const latest = readLatest(project.root);
  assert.equal(latest.runs[S2].active_run_id, a.run_id);
  assert.equal(claimed(project.root, a.run_id).length, 0);
  assert.equal(claimed(project.root, b.run_id).length, 1);

  const view = envelope(status(project, S2));
  assert.equal(view.run_id, a.run_id);
});

test('SB7 two concurrent stops claim the run exactly once', async (t) => {
  const project = tempProject(t);
  const started = runJson(project).envelope;

  const args = ['hook', 'stop', '--project-root', project.root];
  const results = await Promise.all([
    cliAsync([...args, '--session-id', S], { cwd: project.root, env: project.env }),
    cliAsync([...args, '--session-id', S2], { cwd: project.root, env: project.env }),
  ]);

  const claims = claimed(project.root, started.run_id);
  assert.equal(claims.length, 1);

  const latest = readLatest(project.root);
  const winners = Object.keys(latest.runs).filter((key) => !key.startsWith('cli-'));
  assert.equal(winners.length, 1);
  const winner = winners[0];
  assert.equal(latest.runs[winner].active_run_id, started.run_id);
  assert.equal(readState(project.root, started.run_id).session_id, winner);

  const winnerResult = results.find((result) => result.stdout !== '');
  assert.ok(winnerResult, 'one stop must deliver');
  assert.equal(winnerResult.status, 0);
  assert.match(winnerResult.stdout, new RegExp(`submit --session-id ${winner} --step step-a`));
  const loser = results.find((result) => result !== winnerResult);
  assert.ok([0, 5].includes(loser.status), `loser exit ${loser.status}`);
  assert.equal(loser.stdout, '');
});

test('SB8 submit with a claimed cli id exits 2 RUN_CLAIMED and writes nothing', (t) => {
  const project = tempProject(t);
  const started = runJson(project).envelope;
  const cliSid = `cli-${started.run_id}`;
  const stop = hook(project, ['stop', '--session-id', S]);
  assert.equal(stop.status, 0, stop.stderr);

  const beforeState = readState(project.root, started.run_id);
  const beforeEvents = readFileSync(eventsFile(project.root, started.run_id), 'utf8');
  const beforeLatest = readFileSync(join(project.root, '.r2c', 'latest.json'), 'utf8');

  const stale = submit(project, cliSid, 'step-a');
  assert.equal(stale.status, 2, stale.stderr);
  const failed = envelope(stale);
  assert.equal(failed.error.code, 'RUN_CLAIMED');

  for (const command of ['pause', 'resume', 'cancel']) {
    const result = cli(
      [command, '--session-id', cliSid, '--project-root', project.root, '--json'],
      { cwd: project.root, env: project.env },
    );
    assert.equal(result.status, 2, `${command}: ${result.stderr}`);
    assert.equal(envelope(result).error.code, 'RUN_CLAIMED', command);
  }

  assert.deepEqual(readState(project.root, started.run_id), beforeState);
  assert.equal(readFileSync(eventsFile(project.root, started.run_id), 'utf8'), beforeEvents);
  assert.equal(readFileSync(join(project.root, '.r2c', 'latest.json'), 'utf8'), beforeLatest);
});

test('SB9 a paused cli run is not a candidate until resumed', (t) => {
  const project = tempProject(t);
  const started = runJson(project).envelope;
  const cliSid = `cli-${started.run_id}`;

  const paused = cli(
    ['pause', '--project-root', project.root, '--session-id', cliSid],
    { cwd: project.root, env: project.env },
  );
  assert.equal(paused.status, 0, paused.stderr);

  const stop = hook(project, ['stop', '--session-id', S, '--format', 'json']);
  assert.equal(stop.status, 0, stop.stderr);
  assert.equal(stop.stdout, '');
  assert.equal(claimed(project.root, started.run_id).length, 0);

  const resumed = cli(
    ['resume', '--project-root', project.root, '--session-id', cliSid],
    { cwd: project.root, env: project.env },
  );
  assert.equal(resumed.status, 0, resumed.stderr);

  const claimedStop = hook(project, ['stop', '--session-id', S, '--format', 'json']);
  assert.equal(claimedStop.status, 0, claimedStop.stderr);
  assert.match(envelope(claimedStop).reason, new RegExp(`submit --session-id ${S} --step step-a`));
  assert.equal(claimed(project.root, started.run_id).length, 1);
});

test('SB10 replay rebuilds the claim binding without appending an event', (t) => {
  const project = tempProject(t);
  const started = runJson(project).envelope;
  const runId = started.run_id;
  const cliSid = `cli-${runId}`;
  const stop = hook(project, ['stop', '--session-id', S]);
  assert.equal(stop.status, 0, stop.stderr);

  const claimsBefore = claimed(project.root, runId).length;

  const drifted = readState(project.root, runId);
  drifted.session_id = cliSid;
  writeState(project.root, runId, drifted);

  const latest = readLatest(project.root);
  latest.runs[cliSid] = { ...latest.runs[S] };
  writeFileSync(join(project.root, '.r2c', 'latest.json'), `${JSON.stringify(latest, null, 2)}\n`);

  const submitted = submit(project, S, 'step-a');
  assert.equal(submitted.status, 0, submitted.stderr);
  assert.match(submitted.stderr, /repaired/i);

  assert.equal(readState(project.root, runId).session_id, S);
  const repairedLatest = readLatest(project.root);
  assert.equal(repairedLatest.runs[cliSid], undefined);
  assert.equal(repairedLatest.runs[S].active_run_id, runId);
  assert.equal(claimed(project.root, runId).length, claimsBefore);
  assert.equal(claimsBefore, 1);
});
