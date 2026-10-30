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
import {
  appendEvent,
  deactivateLatestRun,
  nowIso,
  readEvents,
  refreshStageFromSteps,
  writeState,
} from './state.js';

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
    // `cmd /s /c "…"` keeps the inner quotes that argv quoting would otherwise
    // eat; without the outer pair `node -e "…"` silently exits 0.
    return {
      file: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', `"${command}"`],
      windowsVerbatimArguments: true,
    };
  }
  return { file: '/bin/sh', args: ['-c', command], windowsVerbatimArguments: false };
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
  const { file, args, windowsVerbatimArguments } = invocation(command);

  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(file, args, {
        cwd,
        windowsHide: true,
        windowsVerbatimArguments,
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
 * State transitions run through `transaction(fn)`, which must call `fn(state)`
 * inside the caller's write lock (submit). Without a transaction the passed
 * `state` object is mutated directly (run owns its fresh run exclusively).
 * Shell commands always run *outside* the transaction so a slow or timed-out
 * step never holds the run lock; the outcome is revalidated when the next
 * transaction loads the state.
 *
 * Returns `{ step, state }` where `step` is the active prompt step or `null`
 * when the workflow completed. Throws exit-3 R2cError on shell failure after
 * marking the step `failed` and the run `paused`.
 */
export async function executeShellSteps({
  manifest,
  projectRoot,
  runId,
  startIndex,
  now = () => new Date(),
  state = null,
  transaction = null,
}) {
  const flat = flattenSteps(manifest);
  let latest = state;
  const eventsNow = () => readEvents(projectRoot, runId) ?? [];
  const mutate = typeof transaction === 'function'
    ? (fn) => transaction((current, events) => {
        latest = current;
        return fn(current, events ?? eventsNow());
      })
    : (fn) => fn(latest, eventsNow());

  /**
   * Append the event and keep the in-flight history in step with it: the stage
   * refresh reads the same history `replayDerived` will read.
   */
  const emit = (events, event) => {
    appendEvent(projectRoot, runId, event);
    events.push(event);
  };

  const prepare = (current, entry, entryIndex, events) => {
    if (current.status !== 'running') {
      throw new R2cError(
        'NO_ACTIVE_RUN',
        `run is not running: ${current.status}`,
        { run_id: runId, status: current.status },
        EXIT_CODES.NO_ACTIVE_RUN,
      );
    }

    if (entry === undefined) {
      const time = nowIso(now());
      current.status = 'completed';
      current.current_step_id = null;
      current.completed_at = time;
      current.updated_at = time;
      emit(events, { kind: 'run', event: 'completed', time });
      for (const stage of current.stages) {
        refreshStageFromSteps(current, stage.id, time, events);
      }
      writeState(projectRoot, runId, current);
      deactivateLatestRun(projectRoot, current.session_id, runId);
      return { kind: 'complete' };
    }

    const step = entry.step;
    const stateStep = stateStepOf(current, step);

    if (step.type !== 'shell') {
      if (stateStep.status !== 'active' || current.current_step_id !== stateStep.id) {
        const time = nowIso(now());
        stateStep.status = 'active';
        current.current_step_id = stateStep.id;
        current.updated_at = time;
        emit(events, {
          kind: 'step',
          event: 'started',
          step: { id: stateStep.id, name: stateStep.name },
          time,
        });
        refreshStageFromSteps(current, stateStep.stage_id, time, events);
        writeState(projectRoot, runId, current);
      }
      return {
        kind: 'deliver',
        step: { id: stateStep.id, name: stateStep.name, status: stateStep.status },
      };
    }

    if (typeof step.shell !== 'string' || step.shell.trim() === '') {
      throw new R2cError(
        'MANIFEST_INVALID',
        `shell step has no command: ${step.id}`,
        { step: step.id },
        EXIT_CODES.USAGE,
      );
    }

    if (stateStep.status !== 'active' || current.current_step_id !== stateStep.id) {
      const time = nowIso(now());
      stateStep.status = 'active';
      current.current_step_id = stateStep.id;
      current.updated_at = time;
      emit(events, {
        kind: 'step',
        event: 'started',
        step: { id: stateStep.id, name: stateStep.name },
        time,
      });
      refreshStageFromSteps(current, stateStep.stage_id, time, events);
      writeState(projectRoot, runId, current);
    }

    return {
      kind: 'execute',
      index: entryIndex,
      step,
      command: step.shell,
      timeoutMs: commandTimeoutMs(step.timeout),
    };
  };

  const record = (current, action, result, events) => {
    const stateStep = stateStepOf(current, action.step);
    if (
      current.status !== 'running'
      || current.current_step_id !== stateStep.id
      || stateStep.status !== 'active'
    ) {
      throw new R2cError(
        'STEP_NOT_ACTIVE',
        `run changed while shell step was executing: ${action.step.id}`,
        {
          step: action.step.id,
          status: current.status,
          current_step_id: current.current_step_id,
          step_status: stateStep.status,
        },
        EXIT_CODES.USAGE,
      );
    }

    const time = nowIso(now());

    if (!result.ok) {
      stateStep.status = 'failed';
      current.status = 'paused';
      current.updated_at = time;
      emit(events, {
        kind: 'step',
        event: 'failed',
        step: { id: stateStep.id, name: stateStep.name },
        command: action.command,
        exit_code: result.exitCode,
        timed_out: result.timedOut,
        time,
      });
      emit(events, { kind: 'run', event: 'paused', time });
      refreshStageFromSteps(current, stateStep.stage_id, time, events);
      writeState(projectRoot, runId, current);
      return { error: shellFailure(action.step, result, action.timeoutMs) };
    }

    stateStep.status = 'completed';
    if (current.current_step_id === stateStep.id) current.current_step_id = null;
    current.updated_at = time;
    emit(events, {
      kind: 'step',
      event: 'completed',
      step: { id: stateStep.id, name: stateStep.name },
      exit_code: result.exitCode,
      time,
    });
    refreshStageFromSteps(current, stateStep.stage_id, time, events);
    writeState(projectRoot, runId, current);
    return { nextIndex: action.index + 1 };
  };

  let index = startIndex;
  for (;;) {
    const action = mutate((current, events) => prepare(current, flat[index], index, events));
    if (action.kind === 'complete') return { step: null, state: latest };
    if (action.kind === 'deliver') return { step: action.step, state: latest };

    const result = await runShellCommand({
      command: action.command,
      cwd: projectRoot,
      timeoutMs: action.timeoutMs,
    });
    const outcome = mutate((current, events) => record(current, action, result, events));
    if (outcome.error) throw outcome.error;
    index = outcome.nextIndex;
  }
}
