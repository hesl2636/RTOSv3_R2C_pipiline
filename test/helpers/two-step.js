/**
 * Runtime two-step fixture.
 *
 * The repository tracks exactly one `workflows/*.yaml` (the default manifest)
 * and one acceptance fixture yaml, so tests that need a generic project build
 * this one in their temp dir instead of tracking a third copy. Shape matches
 * the old `test/fixtures/two-step`: step-a reads tasks/a.md (skills and MCP
 * whitelists), step-b is prompt-only with an inline body.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const TWO_STEP_YAML = `schema: r2c.workflow/v1
id: workflow-two-step
name: two-step
version: 0.1.0
description: 内核验收用两步清单
stages:
  - id: stg-one
    name: 阶段一
    steps:
      - id: step-a
        name: 第一步
        type: prompt
        agent: tester
        taskFile: tasks/a.md
        skills:
          - alpha
          - beta
        mcp:
          - mcp-demo
  - id: stg-two
    name: 阶段二
    steps:
      - id: step-b
        name: 第二步
        type: prompt
        prompt: |
          执行第二步（内联提示）。
`;

export const TWO_STEP_TASK = `# 任务 A

执行第一步，产出可以提交的结果。
`;

/**
 * Write `workflows/two-step.yaml` plus `tasks/a.md` under `root`.
 * `yaml` overrides the manifest text for tests that derive a variant.
 */
export function writeTwoStepProject(root, { yaml = TWO_STEP_YAML } = {}) {
  mkdirSync(join(root, 'workflows'), { recursive: true });
  mkdirSync(join(root, 'tasks'), { recursive: true });
  writeFileSync(join(root, 'workflows', 'two-step.yaml'), yaml);
  writeFileSync(join(root, 'tasks', 'a.md'), TWO_STEP_TASK);
  return root;
}
