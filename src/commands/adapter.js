/**
 * `r2c adapter` command module.
 *
 * Argument parsing stays in `src/cli.js`; this module only turns the adapter
 * result into the human form when `--json` is absent. The JSON envelope is
 * written by the CLI from `data`.
 */
import { join } from 'node:path';
import { runAdapter } from '../adapter/index.js';

function listText(data) {
  const header = ['id', 'version', 'engine', 'agent', 'installed'];
  const rows = data.adapters.map((adapter) => [
    adapter.id,
    adapter.version ?? '-',
    adapter.engine ?? '-',
    adapter.agent ?? '-',
    adapter.installed ? adapter.installed_scopes.join(',') : 'no',
  ]);
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...rows.map((row) => row[index].length)),
  );
  const format = (row) => row.map((cell, index) => cell.padEnd(widths[index])).join('  ').trimEnd();
  return [format(header), ...rows.map(format)].join('\n');
}

function installText(data) {
  const lines = [`adapter ${data.adapter}: ${data.action} (${data.scope}${data.dry_run ? ', dry-run' : ''})`];
  lines.push(`payload ${data.payload.version} from ${data.payload.source}`);
  lines.push(
    `default workflow: ${join(data.payload_home, 'workflows')}`
    + ' (copy workflows/tasks/skills/commands into the project, or use --manifest with an absolute path)',
  );
  if (data.dry_run) {
    for (const step of data.plan) lines.push(`  plan ${step.action} ${step.target}`);
  } else {
    lines.push(`${data.files.length} file(s) changed, ${data.skipped.length} skipped`);
  }
  for (const warning of data.warnings) lines.push(`warn: ${warning}`);
  for (const step of data.manual) lines.push(`manual: ${step}`);
  return lines.join('\n');
}

function uninstallText(data) {
  const lines = [`adapter ${data.adapter}: ${data.action} (${data.scope}${data.dry_run ? ', dry-run' : ''})`];
  lines.push(`${data.files.length} file(s) ${data.dry_run ? 'planned for removal' : 'removed'}`);
  if (data.payload_home) {
    lines.push(
      `payload ${data.payload_removed ? 'removed' : data.payload_shared_with ? `kept (shared with ${data.payload_shared_with})` : 'kept'}: ${data.payload_home}`,
    );
  }
  for (const warning of data.warnings) lines.push(`warn: ${warning}`);
  for (const item of data.leftover) lines.push(`leftover: ${item}`);
  return lines.join('\n');
}

function doctorText(data) {
  const lines = [`doctor ${data.adapter} (${data.scope}): ${data.healthy ? 'healthy' : 'failed'}`];
  for (const check of data.checks) lines.push(`  [${check.status}] ${check.name}: ${check.detail}`);
  return lines.join('\n');
}

function smokeText(data) {
  return `smoke ${data.adapter}: ${data.ok ? 'ok' : 'failed'}${data.detail ? ` (${data.detail})` : ''}`;
}

function pruneText(data) {
  const lines = [`prune: ${data.removed.length} path(s) ${data.dry_run ? 'would be removed' : 'removed'}`];
  for (const path of data.removed) lines.push(`  ${path}`);
  return lines.join('\n');
}

function format(action, data) {
  switch (action) {
    case 'list':
      return listText(data);
    case 'install':
      return installText(data);
    case 'uninstall':
      return uninstallText(data);
    case 'doctor':
      return doctorText(data);
    case 'smoke':
      return smokeText(data);
    case 'prune':
      return pruneText(data);
    default:
      return null;
  }
}

export async function run(argv, ctx) {
  const result = await runAdapter(argv, ctx);
  if (!ctx.json && result?.data) {
    const text = format(argv[0], result.data);
    if (text !== null) result.text = text;
  }
  return result;
}
