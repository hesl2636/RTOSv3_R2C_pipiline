/**
 * Minimal compliant bundle fixture: 1 stage / 1 step / 1 role / 1 task /
 * 1 skill / no constitution. Shared by the assembler and architecture tests.
 */
import { canonicalJson } from '../../core/canonical-json.js';
import { buildZip } from './zip.js';

export const MINIMAL_MANIFEST = {
  schema: 'hm2b.bundle/v2',
  id: 'minimal-demo',
  name: 'Minimal Demo',
  version: '1.0.0',
  description: 'Minimal compliant bundle used by the framework tests.',
  stages: ['only'],
  roles: ['worker'],
  tasks: ['do-it'],
  skills: ['helper'],
};

export const MINIMAL_STAGE = {
  id: 'only',
  name: 'Only Stage',
  steps: [
    {
      id: 'only-step',
      name: 'Only Step',
      role: 'worker',
      task: 'do-it',
      skills: ['helper'],
      outputs: ['out/*.md'],
      gates: [{ command: 'true', timeout: 30 }],
    },
  ],
};

export const MINIMAL_ROLE = [
  '---',
  'id: worker',
  'description: Executes the single step of the minimal workflow.',
  '---',
  '',
  'You execute the only step and record the result.',
  '',
].join('\n');

export const MINIMAL_TASK = [
  '## Agent 角色设定',
  '',
  '你是执行者。',
  '',
  '## 任务',
  '',
  '完成唯一一步。',
  '',
  '## 约束条件',
  '',
  '- 不要跳过任何一步。',
  '',
  '## 提交',
  '',
  '```',
  '{{submit}}',
  '```',
  '',
].join('\n');

export const MINIMAL_SKILL = [
  '---',
  'name: helper',
  'description: Helps with the single step.',
  '---',
  '',
  '# helper',
  '',
  'Read the task book and produce the output file.',
  '',
].join('\n');

/** Map of posix path -> text for the minimal bundle. */
export function minimalFiles(overrides = {}) {
  const files = new Map([
    ['bundle.json', canonicalJson(MINIMAL_MANIFEST)],
    ['stages/only.json', canonicalJson(MINIMAL_STAGE)],
    ['roles/worker.md', MINIMAL_ROLE],
    ['tasks/do-it.md', MINIMAL_TASK],
    ['skills/helper/SKILL.md', MINIMAL_SKILL],
  ]);
  for (const [path, value] of Object.entries(overrides)) {
    if (value === null) files.delete(path);
    else files.set(path, value);
  }
  return files;
}

/** Minimal bundle zip bytes. */
export function minimalZip(options = {}) {
  const files = minimalFiles(options.overrides ?? {});
  return buildZip(files, {
    method: options.method === 'deflate' ? 'deflate' : 'store',
    dataDescriptor: options.dataDescriptor === true,
  });
}

/* --------------------------------------------------------------------------
 * Asset fixture: the minimal bundle plus every asset kind the manifest admits
 * (v2). One knowledge file sits at the four-segment depth limit.
 * ------------------------------------------------------------------------ */

export const ASSET_KNOWLEDGE_BASE = new Map([
  ['knowledge-base/os-api-mapping/freertos.md', [
    '# FreeRTOS to LiteOS',
    '',
    '| Source | Target |',
    '| --- | --- |',
    '| xTaskCreate | LOS_TaskCreate |',
    '',
  ].join('\n')],
  ['knowledge-base/coding-standards/cleancode/rules.md', [
    '# CleanCode rules',
    '',
    '- one return per function',
    '',
  ].join('\n')],
]);

export const ASSET_CHECKLISTS = new Map([
  ['design', '# Design checklist\n\n- [ ] the plan is traceable\n'],
  ['impl', '# Implementation checklist\n\n- [ ] the build is green\n'],
]);

export const ASSET_HOOKS = { hooks: { afterSubmit: ['hm2b status'] } };
export const ASSET_MCP = { mcpServers: { local: { command: 'node', args: ['server.mjs'] } } };

export const ASSET_MANIFEST = {
  ...MINIMAL_MANIFEST,
  knowledgeBase: [...ASSET_KNOWLEDGE_BASE.keys()],
  checklists: [...ASSET_CHECKLISTS.keys()],
  hooks: { path: 'hooks/hooks.json' },
  mcp: { path: 'mcp.json' },
};

/** Map of posix path -> text for the minimal bundle plus declared assets. */
export function assetFiles(overrides = {}) {
  const files = minimalFiles({ 'bundle.json': canonicalJson(ASSET_MANIFEST) });
  for (const [path, body] of ASSET_KNOWLEDGE_BASE) files.set(path, body);
  for (const [id, body] of ASSET_CHECKLISTS) files.set(`checklists/${id}.md`, body);
  files.set('hooks/hooks.json', canonicalJson(ASSET_HOOKS));
  files.set('mcp.json', canonicalJson(ASSET_MCP));
  for (const [path, value] of Object.entries(overrides)) {
    if (value === null) files.delete(path);
    else files.set(path, value);
  }
  return files;
}

/** Minimal bundle zip with declared assets. */
export function assetZip(options = {}) {
  const files = assetFiles(options.overrides ?? {});
  return buildZip(files, {
    method: options.method === 'deflate' ? 'deflate' : 'store',
    dataDescriptor: options.dataDescriptor === true,
    directory: options.directory,
  });
}
