/**
 * Minimal compliant bundle fixture: 1 stage / 1 step / 1 role / 1 task /
 * 1 skill / no constitution. Shared by the assembler and architecture tests.
 */
import { canonicalJson } from '../../core/canonical-json.js';
import { buildZip } from './zip.js';

export const MINIMAL_MANIFEST = {
  schema: 'hm2b.bundle/v1',
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
