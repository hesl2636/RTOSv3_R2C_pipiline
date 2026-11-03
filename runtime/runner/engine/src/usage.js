/**
 * Token usage aggregation.
 *
 * Adapters append cumulative snapshots to `.hm2b/usage/<runId>.jsonl` (one JSON
 * objects per line, schema `hm2b.usage/v1`). Snapshots are *not* increments: the
 * last line for a `(run_id, session_id)` pair is the current total. Summing all
 * lines would count the same tokens again, so the last line always wins.
 */

export const TOKEN_FIELDS = Object.freeze([
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_creation_tokens',
]);

function quantity(value) {
  return Number.isFinite(value) ? value : 0;
}

export function normalizeUsage(value) {
  const usage = {};
  for (const field of TOKEN_FIELDS) usage[field] = quantity(value?.[field]);
  return usage;
}

export function usageTotal(usage) {
  let total = 0;
  for (const field of TOKEN_FIELDS) total += quantity(usage?.[field]);
  return total;
}

function emptyUsage() {
  return normalizeUsage(null);
}

/**
 * Reduce parsed usage lines to one entry per `(run_id, session_id)`.
 *
 * Returns:
 * - `entries`: the selected (last) snapshots, in first-seen order;
 * - `runs`: per-run aggregate (sum over that run's distinct sessions);
 * - `totals`: per-field totals across selected snapshots;
 * - `total`: grand total across selected snapshots;
 * - `source`: `"none"` when there is no snapshot, otherwise the provenance
 *   reported by the snapshots (`transcript`/`hook`) or `"usage"` when mixed.
 */
export function summarizeUsage(lines, { runId = null } = {}) {
  const selected = new Map();

  for (const line of lines) {
    if (line === null || typeof line !== 'object' || Array.isArray(line)) continue;
    const lineRunId = typeof line.run_id === 'string' && line.run_id !== '' ? line.run_id : runId;
    const lineSessionId = typeof line.session_id === 'string' && line.session_id !== ''
      ? line.session_id
      : null;
    const usage = normalizeUsage(line.usage);
    selected.set(`${lineRunId ?? ''}\u0000${lineSessionId ?? ''}`, {
      run_id: lineRunId,
      session_id: lineSessionId,
      adapter: line.adapter ?? null,
      model: line.model ?? null,
      source: line.source ?? null,
      event: line.event ?? null,
      time: line.time ?? null,
      cumulative: line.cumulative === true,
      usage,
      total: usageTotal(usage),
    });
  }

  const entries = [...selected.values()];
  const totals = emptyUsage();
  const runs = new Map();

  for (const entry of entries) {
    for (const field of TOKEN_FIELDS) totals[field] += entry.usage[field];

    let run = runs.get(entry.run_id ?? '');
    if (!run) {
      run = {
        run_id: entry.run_id,
        total: 0,
        usage: emptyUsage(),
        sessions: [],
      };
      runs.set(entry.run_id ?? '', run);
    }
    run.total += entry.total;
    for (const field of TOKEN_FIELDS) run.usage[field] += entry.usage[field];
    run.sessions.push({
      session_id: entry.session_id,
      total: entry.total,
      usage: entry.usage,
      source: entry.source,
      time: entry.time,
    });
  }

  const total = entries.reduce((sum, entry) => sum + entry.total, 0);
  const sources = [...new Set(entries.map((entry) => entry.source).filter(Boolean))];
  const source = entries.length === 0 ? 'none' : (sources.length === 1 ? sources[0] : 'usage');

  return {
    entries,
    runs: Object.fromEntries(runs),
    totals,
    total,
    source,
    sources,
  };
}
