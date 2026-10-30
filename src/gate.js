/**
 * Machine-verifiable step completion (spec §3, I5/I8).
 *
 * Order is fixed: resolve every `expect.outputs` glob first, then run
 * `gate[].command` sequentially in manifest order. A missing output short
 * circuits the gates; a non-zero gate short circuits the remaining gates.
 * Both are exit 3 at the command layer, never a model self-report.
 */
import { globSync } from 'node:fs';
import { DEFAULT_COMMAND_TIMEOUT_MS, commandTimeoutMs, runShellCommand } from './shell.js';

function expectedPatterns(step) {
  const outputs = step?.expect?.outputs;
  return Array.isArray(outputs) ? outputs : [];
}

function gateCommand(gate) {
  const command = gate?.command;
  return typeof command === 'string' && command.trim() !== '' ? command : null;
}

function missingPatterns(patterns, projectRoot) {
  const missing = [];
  let invalid = null;
  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || pattern === '') {
      invalid = pattern;
      continue;
    }
    let matches;
    try {
      matches = globSync(pattern, { cwd: projectRoot });
    } catch (error) {
      invalid = pattern;
      continue;
    }
    if (matches.length === 0) missing.push(pattern);
  }
  return { missing, invalid };
}

export async function checkGates({ step, projectRoot, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS }) {
  const patterns = expectedPatterns(step);
  if (patterns.length > 0) {
    const { missing, invalid } = missingPatterns(patterns, projectRoot);
    if (missing.length > 0 || invalid !== null) {
      const message = missing.length > 0
        ? `missing expected output(s): ${missing.join(', ')}`
        : `invalid expect.outputs pattern: ${String(invalid)}`;
      return {
        ok: false,
        phase: 'outputs',
        code: 'EXPECT_MISSING',
        patterns: missing,
        message,
        details: { phase: 'outputs', patterns: missing },
      };
    }
  }

  const gates = Array.isArray(step?.gate) ? step.gate : [];
  for (const gate of gates) {
    const command = gateCommand(gate);
    if (command === null) continue;
    const effectiveTimeoutMs = commandTimeoutMs(gate?.timeout, timeoutMs);
    const result = await runShellCommand({
      command,
      cwd: projectRoot,
      timeoutMs: effectiveTimeoutMs,
    });
    if (result.ok) continue;

    const details = {
      phase: 'gate',
      command,
      exit_code: result.exitCode,
      timed_out: result.timedOut,
    };
    if (result.stderr.trim() !== '') details.stderr = result.stderr.trim();
    if (result.error !== null) details.error = result.error;
    const reason = result.timedOut
      ? `gate command timed out after ${Math.round(effectiveTimeoutMs / 1000)}s`
      : `gate command exited ${result.exitCode === null ? 'without a status' : result.exitCode}`;
    return {
      ok: false,
      phase: 'gate',
      code: result.timedOut ? 'GATE_TIMEOUT' : 'GATE_FAILED',
      command,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      message: `${reason}: ${command}`,
      details,
    };
  }

  return { ok: true };
}
