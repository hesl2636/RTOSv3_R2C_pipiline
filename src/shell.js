/**
 * Runner-executed shell steps (spec §3, §4).
 *
 * Shell steps never reach the model: the runner executes them in manifest order
 * and delivers only the next `prompt` step (or the completed banner). A shell
 * step that exits non-zero or exceeds its manifest `timeout` marks the step
 * `failed` and pauses the run.
 */
import { spawn, spawnSync } from 'node:child_process';
import { R2cError, EXIT_CODES } from './errors.js';
import { flattenSteps } from './manifest.js';
import { appendEvent, deactivateLatestRun, nowIso, writeState } from './state.js';

/** Spec §3: gate commands default to 120s; shell steps fall back to the same. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

/** Cap captured output so a noisy command cannot grow the runner unbounded. */
const MAX_CAPTURED_CHARS = 10 * 1024 * 1024;

/** Manifest shell `timeout` is in seconds; process APIs want milliseconds. */
export function commandTimeoutMs(seconds, fallback = DEFAULT_COMMAND_TIMEOUT_MS) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.round(value * 1000);
}

function invocation(command) {
  if (process.platform === 'win32') {
    return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] };
  }
  return { file: '/bin/sh', args: ['-c', command] };
}

/**
 * Terminate the command *and its descendants*. `cmd.exe /c node …` is a tree;
 * killing only the shell would leave the actual step running after a timeout.
 */
function killTree(child) {
  if (typeof child.pid !== 'number') return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

function capture(current, chunk) {
  if (current.length >= MAX_CAPTURED_CHARS) return current;
  return current + chunk.toString('utf8');
}

/**
 * Run one manifest command through the platform shell and capture its result.
 * The caller decides whether a failure is a gate rejection or a shell failure.
 */
export function runShellCommand({ command, cwd, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS }) {
  const { file, args } = invocation(command);

  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(file, args, {
        cwd,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolvePromise({
        ok: false,
        timedOut: false,
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        error: String(error?.message ?? error),
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let spawnError = null;
    let settled = false;

    const finish = (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        ok: !timedOut && spawnError === null && exitCode === 0,
        timedOut,
        exitCode: exitCode ?? null,
        signal: signal ?? null,
        stdout,
        stderr,
        error: spawnError,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => {
      stdout = capture(stdout, chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = capture(stderr, chunk);
    });
    child.on('error', (error) => {
      spawnError = String(error?.message ?? error);
      finish(null, null);
    });
    child.on('close', (code, signal) => {
      finish(code, signal);
    });
  });
}

function stateStepOf(state, step) {
  const stateStep = state.steps.find((item) => item.id === step.id);
  if (!stateStep) {
    throw new R2cError(
      'STATE_INCONSISTENT',
      `step missing from state: ${step.id}`,
      { step: step.id },
      EXIT_CODES.INTERNAL,
    );
  }
  return stateStep;
}

function activateStage(state, stageId, time) {
  const stage = state.stages.find((item) => item.id === stageId);
  if (!stage) return;
  stage.status = 'active';
  if (stage.started_at === null) stage.started_at = time;
}

/** Derived stage completion; the run status itself is written by the caller. */
function completeFinishedStages(state, time) {
  for (const stage of state.stages) {
    const members = state.steps.filter((step) => step.stage_id === stage.id);
    if (members.length === 0) continue;
    if (members.every((step) => step.status === 'completed' || step.status === 'skipped')) {
      stage.status = 'completed';
      if (stage.started_at === null) stage.started_at = time;
      if (stage.completed_at === null) stage.completed_at = time;
    }
  }
}

function shellFailure(step, result, timeoutMs) {
  const details = {
    phase: 'shell',
    step: step.id,
    command: step.shell,
    exit_code: result.exitCode,
    timed_out: result.timedOut,
  };
  if (result.stderr.trim() !== '') details.stderr = result.stderr.trim();
  if (result.error !== null) details.error = result.error;

  if (result.timedOut) {
    return new R2cError(
      'SHELL_TIMEOUT',
      `shell step ${step.id} timed out after ${Math.round(timeoutMs / 1000)}s: ${step.shell}`,
      details,
      EXIT_CODES.GATE,
    );
  }
  const status = result.exitCode === null ? 'without a status' : `with exit ${result.exitCode}`;
  return new R2cError(
    'SHELL_FAILED',
    `shell step ${step.id} failed ${status}: ${step.shell}`,
    details,
    EXIT_CODES.GATE,
  );
}

/**
 * Move the cursor from `startIndex` (manifest order) to the next deliverable
 * prompt step, executing any consecutive shell steps on the way.
 *
 * Returns `{ step }` where `step` is the active prompt step or `null` when the
 * workflow completed. Writes state/events; throws exit-3 R2cError on shell
 * failure after marking the step `failed` and the run `paused`.
 */
export async function executeShellSteps({ manifest, projectRoot, state, runId, startIndex, now = () => new Date() }) {
  const flat = flattenSteps(manifest);
  let index = startIndex;

  for (;;) {
    const entry = flat[index];

    if (entry === undefined) {
      const time = nowIso(now());
      state.status = 'completed';
      state.current_step_id = null;
      state.completed_at = time;
      state.updated_at = time;
      completeFinishedStages(state, time);
      appendEvent(projectRoot, runId, { kind: 'run', event: 'completed', time });
      writeState(projectRoot, runId, state);
      deactivateLatestRun(projectRoot, state.session_id, runId);
      return { step: null };
    }

    const step = entry.step;
    const stateStep = stateStepOf(state, step);

    if (step.type !== 'shell') {
      if (stateStep.status !== 'active' || state.current_step_id !== stateStep.id) {
        const time = nowIso(now());
        completeFinishedStages(state, time);
        stateStep.status = 'active';
        state.current_step_id = stateStep.id;
        state.status = 'running';
        state.updated_at = time;
        activateStage(state, stateStep.stage_id, time);
        appendEvent(projectRoot, runId, {
          kind: 'step',
          event: 'started',
          step: { id: stateStep.id, name: stateStep.name },
          time,
        });
        writeState(projectRoot, runId, state);
      }
      return { step: stateStep };
    }

    if (typeof step.shell !== 'string' || step.shell.trim() === '') {
      throw new R2cError(
        'MANIFEST_INVALID',
        `shell step has no command: ${step.id}`,
        { step: step.id },
        EXIT_CODES.USAGE,
      );
    }

    if (stateStep.status !== 'active' || state.current_step_id !== stateStep.id) {
      const time = nowIso(now());
      completeFinishedStages(state, time);
      stateStep.status = 'active';
      state.current_step_id = stateStep.id;
      state.status = 'running';
      state.updated_at = time;
      activateStage(state, stateStep.stage_id, time);
      appendEvent(projectRoot, runId, {
        kind: 'step',
        event: 'started',
        step: { id: stateStep.id, name: stateStep.name },
        time,
      });
      writeState(projectRoot, runId, state);
    }

    const timeoutMs = commandTimeoutMs(step.timeout);
    const result = await runShellCommand({ command: step.shell, cwd: projectRoot, timeoutMs });
    const time = nowIso(now());

    if (!result.ok) {
      stateStep.status = 'failed';
      state.status = 'paused';
      state.updated_at = time;
      appendEvent(projectRoot, runId, {
        kind: 'step',
        event: 'failed',
        step: { id: stateStep.id, name: stateStep.name },
        command: step.shell,
        exit_code: result.exitCode,
        timed_out: result.timedOut,
        time,
      });
      appendEvent(projectRoot, runId, { kind: 'run', event: 'paused', time });
      writeState(projectRoot, runId, state);
      throw shellFailure(step, result, timeoutMs);
    }

    stateStep.status = 'completed';
    if (state.current_step_id === stateStep.id) state.current_step_id = null;
    state.updated_at = time;
    appendEvent(projectRoot, runId, {
      kind: 'step',
      event: 'completed',
      step: { id: stateStep.id, name: stateStep.name },
      exit_code: result.exitCode,
      time,
    });
    completeFinishedStages(state, time);
    writeState(projectRoot, runId, state);
    index += 1;
  }
}
