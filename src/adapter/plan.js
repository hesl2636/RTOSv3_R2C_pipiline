/**
 * Declarations → install plan.
 *
 * `adapter.json` is the identity/contract, `map.json` is data: every entry
 * names a shared payload source, a target template and one of the fixed
 * actions. This module expands those entries into concrete paths and rendered
 * bytes; it never touches the target file system.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { EXIT_CODES, R2cError } from '../errors.js';
import { sha256, userHome } from './util.js';

export const ADAPTER_SCHEMA = 'r2c.adapter/v1';
export const ADAPTER_MAP_SCHEMA = 'r2c.adapter-map/v1';

function usageError(code, message, details = null) {
  return new R2cError(code, message, details, EXIT_CODES.USAGE);
}

function entryByRel(resolved, rel) {
  return resolved.entries.find((entry) => entry.rel === rel) ?? null;
}

/** Locate and parse `adapters/<id>/{adapter,map}.json` inside the payload. */
export function loadAdapterDeclaration(resolved, agentId) {
  const adapterRel = `adapters/${agentId}/adapter.json`;
  const mapRel = `adapters/${agentId}/map.json`;
  const adapterEntry = entryByRel(resolved, adapterRel);
  if (adapterEntry === null) {
    throw usageError('UNKNOWN_ADAPTER', `unknown adapter: ${agentId}`, {
      adapter: agentId,
      available: resolved.entries
        .filter((entry) => /^adapters\/[^/]+\/adapter\.json$/.test(entry.rel))
        .map((entry) => entry.rel.split('/')[1])
        .sort(),
    });
  }
  let adapter;
  try {
    adapter = JSON.parse(readFileSync(adapterEntry.abs, 'utf8'));
  } catch (error) {
    throw usageError('ADAPTER_INVALID_JSON', `cannot parse ${adapterRel}: ${error.message}`, {
      file: adapterRel,
    });
  }
  if (adapter.schema !== ADAPTER_SCHEMA) {
    throw usageError('ADAPTER_SCHEMA_UNSUPPORTED', `unsupported adapter schema: ${adapter.schema}`, {
      adapter: agentId,
      supported: [ADAPTER_SCHEMA],
    });
  }
  if (adapter.id !== agentId) {
    throw usageError('ADAPTER_ID_MISMATCH', `adapter.json id "${adapter.id}" does not match directory "${agentId}"`, {
      adapter: agentId,
    });
  }
  const mapEntry = entryByRel(resolved, mapRel);
  if (mapEntry === null) {
    throw usageError('ADAPTER_MAP_MISSING', `adapter ${agentId} has no map.json`, { adapter: agentId });
  }
  let map;
  try {
    map = JSON.parse(readFileSync(mapEntry.abs, 'utf8'));
  } catch (error) {
    throw usageError('ADAPTER_INVALID_JSON', `cannot parse ${mapRel}: ${error.message}`, {
      file: mapRel,
    });
  }
  if (map.schema !== ADAPTER_MAP_SCHEMA) {
    throw usageError('ADAPTER_MAP_SCHEMA_UNSUPPORTED', `unsupported adapter map schema: ${map.schema}`, {
      adapter: agentId,
      supported: [ADAPTER_MAP_SCHEMA],
    });
  }
  return { adapter, map, adapterRel, mapRel };
}

export function defaultRunnerCommand(ctx, resolved) {
  if (typeof ctx.runnerCmd === 'string' && ctx.runnerCmd !== '') return ctx.runnerCmd;
  const pkg = ctx.packageName || 'r2c-runner';
  return `npx --yes ${pkg}@${resolved.manifest.version}`;
}

function placeholders({ projectRoot, payloadHome, runnerCmd, version, agentId }) {
  return {
    PAYLOAD_HOME: payloadHome,
    PROJECT_ROOT: projectRoot,
    RUNNER_CMD: runnerCmd,
    VERSION: version,
    AGENT_ID: agentId,
  };
}

function substitute(text, values) {
  let output = text;
  for (const [key, value] of Object.entries(values)) {
    output = output.split(`\${${key}}`).join(value);
  }
  return output;
}

/** Render an agent-facing file: `${PLACEHOLDER}` plus the command `<runner>`. */
export function renderText(text, values) {
  return substitute(text, values).replaceAll('<runner>', values.RUNNER_CMD);
}

function expandTarget(template, scopeRoots, extra = {}) {
  let output = template;
  for (const [key, value] of Object.entries(scopeRoots)) {
    output = output.split(`{${key}}`).join(value);
  }
  for (const [key, value] of Object.entries(extra)) {
    output = output.split(`{${key}}`).join(value);
  }
  return normalize(output);
}

function splitFrontmatter(text) {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) return { attributes: {}, body: text };
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (match === null) return { attributes: {}, body: text };
  const attributes = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    attributes[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return { attributes, body: text.slice(match[0].length) };
}

function toPosixName(value) {
  return value.split(/[\\/]/).join('/');
}

function relSegmentMatch(rel, pattern) {
  const relParts = rel.split('/');
  const patternParts = pattern.split('/');
  const match = (relIndex, patternIndex) => {
    if (patternIndex === patternParts.length) return relIndex === relParts.length;
    const part = patternParts[patternIndex];
    if (part === '**') {
      if (match(relIndex, patternIndex + 1)) return true;
      return relIndex < relParts.length && match(relIndex + 1, patternIndex);
    }
    if (relIndex >= relParts.length) return false;
    const escaped = part.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`^${escaped.replaceAll('*', '.*').replaceAll('?', '.')}$`);
    return regex.test(relParts[relIndex]) && match(relIndex + 1, patternIndex + 1);
  };
  return match(0, 0);
}

function matchingEntries(resolved, pattern) {
  if (pattern === '**') return resolved.entries;
  return resolved.entries.filter((entry) => relSegmentMatch(entry.rel, toPosixName(pattern)));
}

function readCapability(adapter, expression) {
  if (typeof expression !== 'string') return undefined;
  return expression.split('.').reduce((value, key) => (value == null ? value : value[key]), adapter);
}

function capabilityEnabled(adapter, expression) {
  if (typeof expression !== 'string') return true;
  const value = readCapability(adapter, expression);
  return value !== undefined && value !== null && value !== false && value !== 'none';
}

function agentsFromPayload(resolved) {
  const roles = new Set();
  for (const entry of resolved.entries) {
    if (!/^workflows\/[^/]+\.yaml$/.test(entry.rel)) continue;
    let document;
    try {
      document = parseYaml(readFileSync(entry.abs, 'utf8'));
    } catch {
      continue;
    }
    for (const stage of document?.stages ?? []) {
      for (const step of stage?.steps ?? []) {
        if (typeof step?.agent === 'string' && step.agent.trim() !== '') roles.add(step.agent.trim());
      }
    }
  }
  return [...roles].sort();
}

/**
 * Build the plan for one install.
 *
 * `mode:"link"` only links directory units declared with `action:"link-root"`;
 * every other file is copied (with a `link-unsupported:` warning), matching
 * #7 §5.
 */
export function buildPlan({
  resolved,
  adapter,
  map,
  scope,
  mode,
  projectRoot,
  payloadHome,
  runnerCmd,
  mcpPath = null,
}) {
  const warnings = [];
  const entries = [];
  const values = placeholders({
    projectRoot,
    payloadHome,
    runnerCmd,
    version: resolved.manifest.version,
    agentId: adapter.id,
  });
  const scopeRoots = { project: projectRoot, user: userHome() };
  const linkRoots = [];
  const mcpAbsolute = mcpPath === null ? null : isAbsolute(mcpPath) ? mcpPath : join(process.cwd(), mcpPath);

  if (mcpAbsolute !== null && !existsSync(mcpAbsolute)) {
    throw usageError('MCP_FILE_NOT_FOUND', `--mcp file does not exist: ${mcpAbsolute}`, {
      file: mcpAbsolute,
    });
  }

  const linkEntries = [];
  const fileEntries = [];
  const mergeEntries = [];

  for (const entry of map.entries ?? []) {
    if (entry.scope !== undefined && entry.scope !== scope) continue;
    if (entry.optional === 'mcp' && mcpAbsolute === null) continue;

    if (entry.action === 'link-root') {
      if (mode !== 'link') continue;
      const source = resolved.topDirs[entry.from] ?? null;
      if (source === null) continue;
      const target = expandTarget(entry.to, scopeRoots);
      linkEntries.push({
        action: 'link',
        kind: 'link',
        sourceRel: entry.from,
        target,
        linkTarget: source,
        sha256: null,
      });
      linkRoots.push(target);
      continue;
    }

    if (entry.action === 'merge-json') {
      mergeEntries.push(buildMergeEntry({ entry, resolved, adapter, target: expandTarget(entry.to, scopeRoots), mcpAbsolute, warnings }));
      continue;
    }

    if (entry.action === 'derive-agent') {
      if (!capabilityEnabled(adapter, entry.enabledBy ?? 'capabilities.agents')) continue;
      const templateEntry = entryByRel(resolved, toPosixName(`adapters/${adapter.id}/${entry.from}`));
      if (templateEntry === null) {
        warnings.push(`derive-agent-source-missing:${entry.from}`);
        continue;
      }
      const template = readFileSync(templateEntry.abs, 'utf8');
      for (const role of agentsFromPayload(resolved)) {
        const name = role.replace(/[^a-zA-Z0-9._-]+/g, '-');
        const target = expandTarget(entry.to, scopeRoots, { name });
        const content = Buffer.from(
          renderText(template, { ...values, AGENT_ROLE: role, NAME: name }),
          'utf8',
        );
        fileEntries.push({
          action: 'derive-agent',
          kind: 'derive-agent',
          sourceRel: templateEntry.rel,
          target,
          content,
          sha256: sha256(content),
        });
      }
      continue;
    }

    if (!['copy', 'render', 'wrap-skill'].includes(entry.action)) {
      throw usageError('MAP_ACTION_UNSUPPORTED', `unsupported map action: ${entry.action}`, {
        action: entry.action,
        adapter: adapter.id,
      });
    }

    const matches = matchingEntries(resolved, entry.from);
    if (matches.length === 0) warnings.push(`map-source-empty:${entry.from}`);
    for (const match of matches) {
      const stem = basename(match.rel).replace(/\.[^.]+$/, '');
      const dir = basename(dirname(match.rel));
      const target = expandTarget(entry.to, scopeRoots, { stem, dir });
      const source = readFileSync(match.abs);
      let content;
      let kind = entry.action;
      if (entry.action === 'render') {
        content = Buffer.from(renderText(source.toString('utf8'), values), 'utf8');
      } else if (entry.action === 'wrap-skill') {
        const { attributes, body } = splitFrontmatter(source.toString('utf8'));
        const description = attributes.description ?? `${stem} (workflow command)`;
        const rendered = renderText(body, values).replace(/^\s*\n/, '');
        content = Buffer.from(
          `---\nname: ${stem}\ndescription: ${description}\n---\n\n${rendered}`,
          'utf8',
        );
        kind = 'wrap-skill';
      }
      fileEntries.push({
        action: entry.action,
        kind,
        sourceRel: match.rel,
        target,
        content: content ?? source,
        sha256: content === undefined ? sha256(source) : sha256(content),
        linkWarning:
          mode === 'link' && !linkRoots.some((root) => target.startsWith(`${root}/`) || target === root)
            ? `link-unsupported:${target}`
            : null,
      });
    }
  }

  for (const entry of linkEntries) entries.push(entry);
  for (const entry of fileEntries) {
    const covered = linkRoots.some((root) => entry.target.startsWith(`${root}/`) || entry.target === root);
    if (covered) continue;
    if (entry.linkWarning !== null) warnings.push(entry.linkWarning);
    delete entry.linkWarning;
    entries.push(entry);
  }
  for (const entry of mergeEntries) entries.push(entry);

  const seen = new Set();
  for (const entry of entries) {
    const key = entry.target;
    if (seen.has(key)) {
      throw usageError('MAP_TARGET_CONFLICT', `two map entries target the same path: ${key}`, {
        adapter: adapter.id,
        path: key,
      });
    }
    seen.add(key);
  }

  return { entries, warnings };
}

function buildMergeEntry({ entry, resolved, adapter, target, mcpAbsolute, warnings }) {
  if (mcpAbsolute === null) {
    throw usageError('MCP_SOURCE_MISSING', `merge-json entry ${entry.from} needs --mcp <file>`, {
      adapter: adapter.id,
    });
  }
  let document;
  try {
    document = JSON.parse(readFileSync(mcpAbsolute, 'utf8'));
  } catch (error) {
    throw usageError('MCP_INVALID_JSON', `cannot parse --mcp file ${mcpAbsolute}: ${error.message}`, {
      file: mcpAbsolute,
    });
  }
  const pointer = Array.isArray(entry.pointers) && entry.pointers.length > 0 ? entry.pointers[0] : null;
  let values = {};
  if (pointer === null) {
    if (document === null || typeof document !== 'object' || Array.isArray(document)) {
      throw usageError('MCP_INVALID_SHAPE', '--mcp file must be a JSON object', {
        file: mcpAbsolute,
      });
    }
    values = document;
  } else {
    let node = document;
    for (const key of pointer.split('.')) {
      node = node == null ? undefined : node[key];
    }
    if (node === null || typeof node !== 'object' || Array.isArray(node)) {
      warnings.push(`mcp-pointer-empty:${pointer}`);
      node = {};
    }
    values = node;
  }
  return {
    action: 'merge-json',
    kind: 'merge-json',
    sourceRel: `mcp:${basename(mcpAbsolute)}`,
    target,
    pointer,
    values,
    sha256: sha256(Buffer.from(JSON.stringify(values))),
  };
}
