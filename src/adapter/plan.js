/**
 * Declarations → install plan.
 *
 * `adapter.json` is the identity/contract, `map.json` is data: every entry
 * names a shared payload source, a target template and one of the fixed
 * actions. This module expands those entries into concrete paths and rendered
 * bytes; it never touches the target file system.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, relative as relativePath } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { EXIT_CODES, R2cError } from '../errors.js';
import { isInside } from '../paths.js';
import { runnerCommand } from '../render.js';
import { sha256, userHome } from './util.js';

export const ADAPTER_SCHEMA = 'r2c.adapter/v1';
export const ADAPTER_MAP_SCHEMA = 'r2c.adapter-map/v1';

/**
 * Payload trees copied verbatim into the project root by every install, so the
 * project owns a manifest and task/skill references `r2c run` can discover.
 */
export const LAYOUT_DIRS = Object.freeze(['workflows', 'tasks', 'skills']);

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

/**
 * The command installed configs carry (C3/C9): `--runner-cmd` when the caller
 * overrode it, else `node <engine entry>` — project-relative for a project
 * scope whose engine lives inside the project, absolute (quoted when needed)
 * everywhere else. Distinct from `render.js`'s `defaultRunnerCommand`, which
 * renders the same text from the running engine's own path.
 */
export function installedRunnerCommand(ctx, engine, scope) {
  if (typeof ctx.runnerCmd === 'string' && ctx.runnerCmd !== '') return ctx.runnerCmd;
  return runnerCommand(engine.entry, { projectRoot: scope === 'project' ? ctx.projectRoot : null });
}

/**
 * Placeholder values for the agent-facing templates.
 *
 * Project scope writes only paths relative to the project root (C3), so a
 * renamed or moved project keeps its installed hooks working; user scope keeps
 * absolute paths because the agent's working directory is not the project.
 */
function placeholders({ projectRoot, payloadHome, runnerCmd, scope, version, agentId }) {
  const relativeHome = relativePath(projectRoot, payloadHome);
  const homeInside = relativeHome !== '' && isInside(projectRoot, payloadHome);
  const projectScope = scope === 'project';
  const root = projectScope ? '.' : projectRoot;
  return {
    PAYLOAD_HOME: projectScope && homeInside ? toPosixName(relativeHome) : payloadHome,
    // Project scope is relative to the project root, so a moved project keeps
    // its hooks working; a batch file needs `.\` and gets it from the template.
    PROJECT_ROOT: root,
    RUNNER_CMD: runnerCmd,
    // Same command embedded inside a double-quoted shell word (JSON hook
    // settings, .cmd files): the inner quotes must survive the outer pair.
    RUNNER_CMD_DQ: runnerCmd.replaceAll('"', '\\"'),
    RUNNER_CMD_BATCH: runnerCmd.replaceAll('"', '""'),
    NODE_BIN: process.execPath,
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

/**
 * Render a JSON template. Placeholder values are JSON-escaped (without the
 * surrounding quotes the template owns), so a Windows path never becomes an
 * invalid escape sequence.
 */
export function renderJsonText(text, values) {
  let output = text;
  for (const [key, value] of Object.entries(values)) {
    output = output.split(`\${${key}}`).join(JSON.stringify(String(value)).slice(1, -1));
  }
  return output.replaceAll('<runner>', JSON.stringify(values.RUNNER_CMD).slice(1, -1));
}

/** Render placeholders inside a parsed JSON value, leaving structure intact. */
function renderJsonStrings(value, values) {
  if (typeof value === 'string') return renderText(value, values);
  if (Array.isArray(value)) return value.map((item) => renderJsonStrings(item, values));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, renderJsonStrings(item, values)]),
    );
  }
  return value;
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

/** One plan entry per payload layout file: a byte copy under the project root. */
function layoutEntries({ resolved, projectRoot }) {
  const entries = [];
  for (const payloadEntry of resolved.entries) {
    if (!LAYOUT_DIRS.some((dir) => payloadEntry.rel.startsWith(`${dir}/`))) continue;
    const content = readFileSync(payloadEntry.abs);
    entries.push({
      action: 'layout',
      kind: 'layout',
      // Recorded project-relative: a renamed or moved project still resolves it.
      rel: payloadEntry.rel,
      target: join(projectRoot, payloadEntry.rel),
      content,
      sha256: sha256(content),
    });
  }
  return entries;
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
    scope,
    version: resolved.manifest.version,
    agentId: adapter.id,
  });
  const scopeRoots = { project: projectRoot, user: userHome(), payload: payloadHome };
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
      const target = expandTarget(entry.to, scopeRoots);
      const pointers = Array.isArray(entry.pointers) && entry.pointers.length > 0 ? entry.pointers : [null];
      for (const pointer of pointers) {
        mergeEntries.push(
          buildMergeEntry({ entry, adapter, target, pointer, mcpAbsolute, warnings, values, resolved }),
        );
      }
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

    let matches = matchingEntries(resolved, entry.from);
    if (matches.length === 0 && !toPosixName(entry.from).startsWith('adapters/')) {
      matches = matchingEntries(resolved, `adapters/${adapter.id}/${toPosixName(entry.from)}`);
    }
    if (matches.length === 0) warnings.push(`map-source-empty:${entry.from}`);
    for (const match of matches) {
      const stem = basename(match.rel).replace(/\.[^.]+$/, '');
      const dir = basename(dirname(match.rel));
      const target = expandTarget(entry.to, scopeRoots, { stem, dir });
      const source = readFileSync(match.abs);
      let content;
      let kind = entry.action;
      if (entry.action === 'render') {
        const render = /\.json$/i.test(target) ? renderJsonText : renderText;
        content = Buffer.from(render(source.toString('utf8'), values), 'utf8');
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
          mode === 'link' && !linkRoots.some((root) => isInside(root, target))
            ? `link-unsupported:${target}`
            : null,
      });
    }
  }

  for (const entry of layoutEntries({ resolved, projectRoot })) fileEntries.push(entry);

  for (const entry of linkEntries) entries.push(entry);
  for (const entry of fileEntries) {
    const covered = linkRoots.some((root) => isInside(root, entry.target));
    if (covered) continue;
    // Only map-derived copies carry `linkWarning`; layout and derive-agent
    // entries have none, and an `undefined` here printed `warn: undefined`.
    if (typeof entry.linkWarning === 'string') warnings.push(entry.linkWarning);
    delete entry.linkWarning;
    entries.push(entry);
  }
  for (const entry of mergeEntries) entries.push(entry);

  const seen = new Map();
  for (const entry of entries) {
    const key = entry.target;
    const previous = seen.get(key);
    if (previous !== undefined && !(previous === 'merge-json' && entry.action === 'merge-json')) {
      throw usageError('MAP_TARGET_CONFLICT', `two map entries target the same path: ${key}`, {
        adapter: adapter.id,
        path: key,
      });
    }
    seen.set(key, entry.action);
  }

  return { entries, warnings };
}

function buildMergeEntry({ entry, adapter, target, pointer, mcpAbsolute, warnings, values, resolved }) {
  let document;
  let sourceRel;
  if (entry.from === '--mcp') {
    if (mcpAbsolute === null) {
      throw usageError('MCP_SOURCE_MISSING', `merge-json entry ${entry.from} needs --mcp <file>`, {
        adapter: adapter.id,
      });
    }
    sourceRel = `mcp:${basename(mcpAbsolute)}`;
    try {
      document = JSON.parse(readFileSync(mcpAbsolute, 'utf8'));
    } catch (error) {
      throw usageError('MCP_INVALID_JSON', `cannot parse --mcp file ${mcpAbsolute}: ${error.message}`, {
        file: mcpAbsolute,
      });
    }
  } else {
    const rel = toPosixName(`adapters/${adapter.id}/${entry.from}`);
    const assetEntry = entryByRel(resolved, rel) ?? entryByRel(resolved, toPosixName(entry.from));
    if (assetEntry === null) {
      throw usageError('MAP_SOURCE_MISSING', `merge-json source not found: ${entry.from}`, {
        adapter: adapter.id,
        path: entry.from,
      });
    }
    sourceRel = assetEntry.rel;
    try {
      // Render inside JSON values, after parsing: a Windows payload path
      // contains backslashes that must stay escaped in the document bytes.
      document = renderJsonStrings(JSON.parse(readFileSync(assetEntry.abs, 'utf8')), values);
    } catch (error) {
      throw usageError('MERGE_SOURCE_INVALID_JSON', `cannot parse ${assetEntry.rel}: ${error.message}`, {
        file: assetEntry.rel,
      });
    }
  }
  let mergedValues = {};
  if (pointer === null) {
    if (document === null || typeof document !== 'object' || Array.isArray(document)) {
      throw usageError('MERGE_INVALID_SHAPE', 'merge-json source must be a JSON object', {
        file: sourceRel,
      });
    }
    mergedValues = document;
  } else {
    let node = document;
    for (const key of pointer.split('.')) {
      node = node == null ? undefined : node[key];
    }
    if (node === null || typeof node !== 'object') {
      warnings.push(`merge-pointer-empty:${pointer}`);
      node = {};
    }
    mergedValues = node;
  }
  return {
    action: 'merge-json',
    kind: 'merge-json',
    sourceRel,
    target,
    pointer,
    values: mergedValues,
    sha256: sha256(Buffer.from(JSON.stringify(mergedValues))),
  };
}
