/**
 * agent-native projection manifest (#71 §3.1).
 *
 * `projection.json` is the frozen on-disk form; this module is the static
 * import the registry uses (JSON import attributes are not available across
 * the whole supported Node range). A test asserts the file is exactly
 * `canonicalJson(AGENT_NATIVE_MANIFEST)`, so the two cannot drift.
 *
 * Adding a target (#96–#99): one descriptor file under `targets/`, one entry
 * in `targets/index.js`, then regenerate `projection.json` from this manifest.
 */
import { compareCodePoints } from '../../../core/code-point.js';
import { COMPILED_WORKFLOW_SCHEMA } from '../../../compiled/schema.js';
import { TARGETS, TARGET_ORDER } from './targets/index.js';

function targetEntry(id) {
  const target = TARGETS[id];
  const capabilities = {};
  for (const [capability, level] of Object.entries(target.capabilities)) {
    capabilities[capability] = { level, note: target.capabilityNotes[capability] };
  }
  return {
    id: target.id,
    name: target.name,
    default: target.default,
    capabilities,
  };
}

/** Stable asset id: <target>-<basename-without-extension>, dots and slashes folded. */
function assetId(targetId, path) {
  const relative = path.replace(`runtime/agent-native/targets/${targetId}/assets/`, '').replace(/\.[^.]*$/, '');
  return `${targetId}-${relative.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`;
}

/** Every static asset the target descriptors ship, sorted by id. */
function assetEntries() {
  const assets = new Map();
  for (const id of TARGET_ORDER) {
    for (const asset of TARGETS[id].assets ?? []) {
      assets.set(asset.path, { id: assetId(id, asset.path), path: asset.path, sha256: asset.sha256 });
    }
  }
  return [...assets.values()].sort((left, right) => compareCodePoints(left.id, right.id));
}

const writeRoots = ['.agents/agent-native', '.agents/skills'];
for (const id of TARGET_ORDER) {
  const { skillsRoot, agentsRoot } = TARGETS[id].layout;
  for (const root of [agentsRoot, skillsRoot]) {
    if (!writeRoots.includes(root)) writeRoots.push(root);
  }
}
writeRoots.sort();

export const AGENT_NATIVE_MANIFEST = Object.freeze({
  schema: 'hm2b.projection/v1',
  id: 'agent-native',
  name: 'Agent-native 投影',
  version: '0.1.0',
  description: '把中立 compiled workflow 投影成原生 agent runtime 的技能与子 agent 定义；不生成 runner，不写用户自有配置文件。',
  api: {
    compiledWorkflow: COMPILED_WORKFLOW_SCHEMA,
    options: 'hm2b.projection-options/v1',
    result: 'hm2b.projection-result/v1',
  },
  writeRoots,
  targets: TARGET_ORDER.map(targetEntry),
  // The host hook/MCP assets are static bytes, not generated content: the
  // manifest declares them so a reader can verify what the runtime copies.
  assets: assetEntries(),
  // Closed: agent-native declares no custom options, so `extra` must be `{}`.
  optionsSchema: Object.freeze({
    type: 'object',
    additionalProperties: false,
    properties: Object.freeze({}),
  }),
});
