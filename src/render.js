/**
 * Plain-text delivery renderers. This module is the single source of the B/C
 * visible text and of `next --format plain` (spec §4); adapters must not wrap
 * or alter the returned body.
 */
import { isAbsolute, relative, resolve } from 'node:path';
import { R2cError, EXIT_CODES } from './errors.js';
import { findStep, flattenSteps, hasSkillFile, readTaskFile, skillFilePath } from './manifest.js';

function quotePath(file) {
  // Forward slashes are accepted by cmd, PowerShell and POSIX shells on
  // Windows; backslashes are eaten by POSIX shells unless quoted, and quoting
  // is reserved for paths that contain whitespace.
  const portable = process.platform === 'win32' ? file.replaceAll('\\', '/') : file;
  return /\s/.test(portable) ? `"${portable.replaceAll('"', '\\"')}"` : portable;
}

/**
 * `node <entry>` — the one command text every surface prints and every
 * installed agent config carries (C3).
 *
 * With `projectRoot`, an entry that lives inside the project is written
 * **project-relative** so renaming or moving the project keeps the installed
 * hooks working; an entry outside the project stays absolute and is quoted
 * when it contains whitespace.
 */
export function runnerCommand(entry, { projectRoot = null } = {}) {
  const absolute = resolve(entry);
  if (projectRoot !== null) {
    const inside = relative(projectRoot, absolute);
    if (inside !== '' && !inside.startsWith('..') && !isAbsolute(inside)) {
      return `node ${quotePath(inside)}`;
    }
  }
  return `node ${quotePath(absolute)}`;
}

/** Default Submit-line prefix, directly executable from any cwd. */
export function defaultRunnerCommand(binPath, options = {}) {
  return runnerCommand(resolve(binPath), options);
}

function bodyOf(root, step) {
  const parts = [];
  if (typeof step.prompt === 'string' && step.prompt.trim() !== '') {
    parts.push(step.prompt.trimEnd());
  }
  const task = readTaskFile(root, step);
  if (task !== null && task.trim() !== '') parts.push(task.trimEnd());
  if (parts.length === 0) {
    throw new R2cError(
      'MANIFEST_INVALID',
      `prompt step has neither prompt text nor a task file: ${step.id}`,
      { step: step.id },
      EXIT_CODES.USAGE,
    );
  }
  return parts.join('\n\n');
}

function metaLines(root, step) {
  const lines = [];
  if (typeof step.agent === 'string' && step.agent !== '') {
    lines.push(`角色：${step.agent}`);
  }
  if (typeof step.skill === 'string' && step.skill !== '') {
    const file = skillFilePath(root, step.skill);
    lines.push(hasSkillFile(root, step.skill) ? `主技能：${step.skill}（见 ${file}）` : `主技能：${step.skill}`);
  }
  if (Array.isArray(step.skills) && step.skills.length > 0) {
    lines.push(`技能白名单：${step.skills.join('、')}`);
  }
  if (Array.isArray(step.mcp) && step.mcp.length > 0) {
    lines.push(`MCP 白名单：${step.mcp.join('、')}`);
  }
  if (step.subagent === true) {
    lines.push('子代理：本步建议由子代理执行；主会话负责提交。');
  }
  return lines;
}

export function renderCompleted(runId) {
  return `## 工作流完成（run ${runId}）\n`;
}

/**
 * Resolve every prompt step's task file before a run is created (or a submit
 * advances), so a missing task file is a clean exit 2 with no partial writes.
 */
export function assertRenderableSteps(manifest, root) {
  for (const { step } of flattenSteps(manifest)) {
    if (step.type === 'prompt') bodyOf(root, step);
  }
}

/** Render one step block (used identically for `run`, `submit` and `next`). */
export function renderStep({ manifest, root, stepId, runnerCmd, sessionId, manifestPath = null }) {
  const found = findStep(manifest, stepId);
  if (!found) {
    throw new R2cError(
      'STEP_NOT_FOUND',
      `step not found in manifest: ${stepId}`,
      { step: stepId },
      EXIT_CODES.INTERNAL,
    );
  }
  const { step, stage } = found;
  const meta = metaLines(root, step);
  const header = `## 下一步：${step.name}（阶段：${stage.name}）`;
  const body = bodyOf(root, step);
  // An explicit `--manifest` must survive into the Submit line, otherwise the
  // printed command cannot rediscover the same manifest from the project root.
  const manifestArg = manifestPath === null ? '' : ` --manifest "${manifestPath}"`;
  const submit = [
    '提交命令（完成后执行；不要手改 .r2c）：',
    `${runnerCmd} submit --session-id ${sessionId} --step ${step.id}${manifestArg}`,
  ].join('\n');
  return [header, meta.length > 0 ? meta.join('\n') : null, body, submit]
    .filter((part) => part !== null)
    .join('\n\n')
    .concat('\n');
}
