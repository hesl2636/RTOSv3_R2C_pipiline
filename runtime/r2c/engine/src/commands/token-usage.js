/**
 * `r2c token-usage`: read cumulative token snapshots for the routed run.
 *
 * Snapshots are cumulative, so the last line per `(run_id, session_id)` wins.
 * Missing usage file is a normal zero result, not an error.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { R2cError, EXIT_CODES } from '../errors.js';
import { r2cDir } from '../paths.js';
import { resolveRunForSession } from '../state.js';
import { summarizeUsage } from '../usage.js';

function usageFile(root, runId) {
  return join(r2cDir(root), 'usage', `${runId}.jsonl`);
}

function readLines(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new R2cError(
          'USAGE_INVALID',
          `invalid usage line ${index + 1}: ${file}`,
          { file, line: index + 1, cause: error?.message ?? String(error) },
          EXIT_CODES.INTERNAL,
        );
      }
    });
}

function renderText(runId, summary) {
  const lines = [`run/${runId} total=${summary.total} source=${summary.source}`];
  for (const entry of summary.entries) {
    const usage = entry.usage;
    lines.push(
      `usage/${entry.run_id ?? runId}/${entry.session_id ?? '-'} total=${entry.total}` +
      ` input_tokens=${usage.input_tokens}` +
      ` output_tokens=${usage.output_tokens}` +
      ` cache_read_tokens=${usage.cache_read_tokens}` +
      ` cache_creation_tokens=${usage.cache_creation_tokens}` +
      ` source=${entry.source ?? 'none'}`,
    );
  }
  return lines.join('\n').concat('\n');
}

export async function run(_argv, ctx) {
  const loaded = resolveRunForSession({
    root: ctx.projectRoot,
    sessionId: ctx.sessionId,
    fallbackToLatest: true,
  });
  if (loaded === null) {
    throw new R2cError(
      'NO_ACTIVE_RUN',
      'no active run for this session',
      { session_id: ctx.sessionId ?? null },
      EXIT_CODES.NO_ACTIVE_RUN,
    );
  }

  const runId = loaded.state.run_id;
  const summary = summarizeUsage(readLines(usageFile(ctx.projectRoot, runId)), { runId });

  return {
    runId,
    sessionId: loaded.state.session_id,
    step: null,
    text: renderText(runId, summary),
    data: {
      run_id: runId,
      ...summary,
    },
  };
}
