/**
 * Isolated child runner for the release packager (decision #75 §10.8).
 *
 * `process.execPath` + an argument array, never a shell. stdout is JSON-lines,
 * stderr is capped and redacted, and a timeout kills the child without
 * touching the server. Server-only module.
 */
import { isPlainObject } from '../assembler/util.js';
import { redactSecrets } from './env.js';

const STDERR_MAX_BYTES = 16 * 1024;
const STDOUT_LINE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Run the release packager as an isolated child.
 *
 * Non-publish children lose the GitHub credentials before `env` reaches this
 * helper; the publish child is the only caller allowed to keep them.
 */
export function runReleaseChild({ spawn, script, args, env, cwd, timeoutMs, secrets, onEvent = null }) {
  return new Promise((resolveChild) => {
    let child;
    try {
      child = spawn(process.execPath, ['--max-old-space-size=512', script, ...args], {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolveChild({
        status: 'failed',
        code: null,
        signal: null,
        events: [],
        logLines: [],
        stderr: redactSecrets(String(error?.message ?? error), secrets),
        stderrTruncated: false,
      });
      return;
    }

    const events = [];
    const logLines = [];
    let stdoutBuffer = '';
    let stderr = '';
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    const consume = (line) => {
      if (line.trim() === '') return;
      if (line.length > STDOUT_LINE_MAX_BYTES) {
        logLines.push('[oversized stdout line]');
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        logLines.push(redactSecrets(line, secrets));
        return;
      }
      if (isPlainObject(parsed) && typeof parsed.event === 'string') {
        events.push(parsed);
        if (typeof onEvent === 'function') {
          try {
            onEvent(parsed);
          } catch {
            // A consumer error must never take down the child or the server.
          }
        }
      } else logLines.push(redactSecrets(line, secrets));
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk;
      let index;
      while ((index = stdoutBuffer.indexOf('\n')) !== -1) {
        const line = stdoutBuffer.slice(0, index);
        stdoutBuffer = stdoutBuffer.slice(index + 1);
        consume(line);
      }
      if (stdoutBuffer.length > STDOUT_LINE_MAX_BYTES) {
        stdoutBuffer = '';
        logLines.push('[oversized stdout line]');
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (stderr.length >= STDERR_MAX_BYTES) {
        stderrTruncated = true;
        return;
      }
      const remaining = STDERR_MAX_BYTES - stderr.length;
      stderr += chunk.slice(0, remaining);
      if (chunk.length > remaining) stderrTruncated = true;
    });

    const finish = (status, code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (stdoutBuffer !== '') consume(stdoutBuffer);
      resolveChild({
        status,
        code,
        signal,
        events,
        logLines,
        stderr: redactSecrets(stderr, secrets),
        stderrTruncated,
      });
    };
    child.on('error', (error) => {
      stderr += String(error?.message ?? error);
      finish('failed', null, null);
    });
    child.on('close', (code, signal) => {
      if (timedOut) finish('timeout', code, signal);
      else finish(code === 0 ? 'exited' : 'failed', code, signal);
    });
  });
}
