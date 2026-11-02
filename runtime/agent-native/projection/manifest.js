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

const writeRoots = ['.agents/agent-native', '.agents/skills'];
for (const id of TARGET_ORDER) {
  const { skillsRoot, agentsRoot } = TARGETS[id].layout;
  for (const root of [agentsRoot, skillsRoot]) {
    if (!writeRoots.includes(root)) writeRoots.push(root);
  }
}
writeRoots.sort();

export const AGENT_NATIVE_MANIFEST = Object.freeze({
  schema: 'r2c.projection/v1',
  id: 'agent-native',
  name: 'Agent-native 投影',
  version: '0.1.0',
  description: '把中立 IR 投影成原生 agent runtime 的技能与子 agent 定义；不生成 runner，不写用户自有配置文件。',
  api: {
    ir: 'r2c.ir/v1',
    options: 'r2c.projection-options/v1',
    result: 'r2c.projection-result/v1',
  },
  writeRoots,
  targets: TARGET_ORDER.map(targetEntry),
  assets: [],
});
