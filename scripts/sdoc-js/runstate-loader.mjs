// runstate-loader.mjs — 自动发现并解析步骤边界信息
// 用于将 session slices 映射到 workflow steps
//
// 发现策略（按优先级）：
//   1. runs/{runId}/trace/events.jsonl  — Harness 运行时实际写入的路径
//   2. sessionDir/run-state/run-{sessionId}/trace/events.jsonl  — 旧路径（兼容）
//   3. sessionDir 父目录下的 runs/ 目录扫描

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';

/**
 * 从 runs/ 目录自动发现步骤边界
 * 查找策略：
 *   1. sessionDir/../runs/{runId}/trace/events.jsonl（已知 runId）
 *   2. sessionDir/../runs/ 下扫描所有 R* 子目录
 *   3. sessionDir/runs/ 下扫描
 *
 * 参考 ca-viewer 的 runStateParser.ts 和 resolveTurnBindings.ts
 */
export function discoverRunsDir(jsonlPath, runId = null) {
  const sessionDir = dirname(jsonlPath);

  // 策略 1：已知 runId，直接定位
  if (runId) {
    const candidates = [
      join(sessionDir, '..', 'runs', runId),
      join(sessionDir, 'runs', runId),
    ];
    for (const dir of candidates) {
      const eventsPath = join(dir, 'trace', 'events.jsonl');
      if (existsSync(eventsPath)) return dir;
    }
  }

  // 策略 2：扫描 runs/ 目录下所有 R* 子目录
  const runsRoots = [
    join(sessionDir, '..', 'runs'),
    join(sessionDir, 'runs'),
  ];

  for (const runsRoot of runsRoots) {
    if (!existsSync(runsRoot) || !statSync(runsRoot).isDirectory()) continue;
    try {
      const entries = readdirSync(runsRoot);
      // 优先匹配 runId
      if (runId) {
        for (const entry of entries) {
          if (entry !== runId) continue;
          const dir = join(runsRoot, entry);
          const eventsPath = join(dir, 'trace', 'events.jsonl');
          if (existsSync(eventsPath)) return dir;
        }
      }
      // 返回第一个有 events.jsonl 的
      for (const entry of entries) {
        const dir = join(runsRoot, entry);
        try {
          if (!statSync(dir).isDirectory()) continue;
        } catch { continue; }
        const eventsPath = join(dir, 'trace', 'events.jsonl');
        if (existsSync(eventsPath)) return dir;
      }
    } catch {
      // ignore
    }
  }

  return null;
}

// 旧路径发现（兼容保留）
// 查找策略：
//   1. sessionDir/run-state/run-sessionId/trace/events.jsonl
//   2. sessionDir/run-state/ 下任意 run-*/trace/events.jsonl
//   3. sessionDir 父目录下的 run-state/run-sessionId/trace/events.jsonl
export function discoverRunStateDir(jsonlPath, sessionId) {
  const sessionDir = dirname(jsonlPath);
  const candidates = [
    join(sessionDir, 'run-state', `run-${sessionId}`),
    join(sessionDir, '..', 'run-state', `run-${sessionId}`),
  ];

  for (const dir of candidates) {
    const eventsPath = join(dir, 'trace', 'events.jsonl');
    if (existsSync(eventsPath)) {
      return dir;
    }
  }

  // 回退：扫描 run-state 目录下所有 run-* 子目录
  const runStateRoot = join(sessionDir, 'run-state');
  if (existsSync(runStateRoot) && statSync(runStateRoot).isDirectory()) {
    try {
      for (const entry of readdirSync(runStateRoot)) {
        if (!entry.startsWith('run-')) continue;
        const dir = join(runStateRoot, entry);
        const eventsPath = join(dir, 'trace', 'events.jsonl');
        if (existsSync(eventsPath)) {
          // 如果 sessionId 匹配，优先返回；否则返回第一个找到的
          if (entry === `run-${sessionId}`) return dir;
        }
      }
      // 如果没有精确匹配，返回第一个有 events.jsonl 的
      for (const entry of readdirSync(runStateRoot)) {
        if (!entry.startsWith('run-')) continue;
        const dir = join(runStateRoot, entry);
        const eventsPath = join(dir, 'trace', 'events.jsonl');
        if (existsSync(eventsPath)) return dir;
      }
    } catch {
      // ignore
    }
  }

  return null;
}

/**
 * 解析 events.jsonl，提取步骤边界
 *
 * @param {string} runStateDir run-state 目录路径
 * @returns {{steps: Array<{stepId: string, name: string, startTs: string, endTs: string, order: number}>, workflow: Object|null}}
 */
export function loadStepBoundaries(runStateDir) {
  const eventsPath = join(runStateDir, 'trace', 'events.jsonl');
  if (!existsSync(eventsPath)) return { steps: [], workflow: null };

  const text = readFileSync(eventsPath, 'utf-8');
  const lines = text.split('\n').filter(l => l.trim());

  const steps = [];
  const stepMap = new Map(); // stepId → { stepId, name, startTs, endTs, order }

  let stepOrder = 0;

  for (const line of lines) {
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      continue;
    }

    if (evt.kind !== 'step') continue;

    const stepData = evt.step || {};
    const stepId = stepData.id;
    if (!stepId) continue;

    if (evt.event === 'started') {
      if (!stepMap.has(stepId)) {
        stepMap.set(stepId, {
          stepId,
          name: stepData.name || stepId,
          startTs: evt.time || '',
          endTs: '',
          order: stepOrder++,
        });
      } else {
        // 已存在（可能重复 started），更新 startTs
        const existing = stepMap.get(stepId);
        if (!existing.startTs) existing.startTs = evt.time || '';
      }
    } else if (evt.event === 'completed' || evt.event === 'submitted') {
      // harness 的 step 完成事件可能是 completed 或 submitted（submit command 提交步骤），
      // 都视为 step 结束时间。否则 endTs 永远为空，窗口变成 [startTs, +∞) 覆盖后续调用。
      if (!stepMap.has(stepId)) {
        // completed/submitted 在 started 之前（异常情况），创建条目
        stepMap.set(stepId, {
          stepId,
          name: stepData.name || stepId,
          startTs: '',
          endTs: evt.time || '',
          order: stepOrder++,
        });
      } else {
        stepMap.get(stepId).endTs = evt.time || '';
      }
    }
  }

  // 按顺序排列
  for (const step of stepMap.values()) {
    steps.push(step);
  }
  steps.sort((a, b) => a.order - b.order);

  // 同时解析 workflow.yaml 获取 expectations
  const workflow = _loadWorkflowYaml(runStateDir);

  // 合并 expectations 到 steps
  if (workflow && workflow.steps) {
    const wfStepMap = new Map();
    for (const ws of workflow.steps) {
      wfStepMap.set(ws.stepId, ws);
    }
    for (const step of steps) {
      const ws = wfStepMap.get(step.stepId);
      if (ws) {
        step.expectations = ws.expectations || [];
      }
    }
  }

  return { steps, workflow };
}

/**
 * 解析 workflow.yaml（简单解析器，提取步骤和期望）
 */
function _loadWorkflowYaml(runStateDir) {
  const yamlPath = join(runStateDir, 'workflow.yaml');
  if (!existsSync(yamlPath)) return null;

  const content = readFileSync(yamlPath, 'utf-8');
  const steps = [];
  const lines = content.split('\n');
  let currentStep = null;
  let inSteps = false;
  let inExpectations = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === 'steps:') {
      inSteps = true;
      continue;
    }

    if (!inSteps) continue;

    if (trimmed.startsWith('- id:') || trimmed.startsWith('-id:')) {
      if (currentStep && currentStep.stepId) {
        steps.push(currentStep);
      }
      currentStep = {
        stepId: trimmed.replace(/^-?\s*id:\s*/, '').trim(),
        expectations: [],
      };
      inExpectations = false;
      continue;
    }

    if (!currentStep) continue;

    if (trimmed.startsWith('name:')) {
      currentStep.name = trimmed.replace(/^name:\s*/, '').trim();
      continue;
    }

    if (trimmed === 'expectations:') {
     inExpectations = true;
      continue;
    }

    if (inExpectations && trimmed.startsWith('- id:')) {
      const exp = {
        id: trimmed.replace(/^-?\s*id:\s*/, '').trim(),
        kind: 'skill',
        match: '',
      };
      currentStep.expectations.push(exp);
      continue;
    }

    if (inExpectations && currentStep.expectations.length > 0) {
      const lastExp = currentStep.expectations[currentStep.expectations.length - 1];
      if (trimmed.startsWith('kind:')) {
        lastExp.kind = trimmed.replace(/^kind:\s*/, '').trim();
      } else if (trimmed.startsWith('match:')) {
        lastExp.match = trimmed.replace(/^match:\s*/, '').trim();
      }
    }
  }

  if (currentStep && currentStep.stepId) {
    steps.push(currentStep);
  }

  return { steps };
}

/**
 * 自动发现并加载步骤边界
 * 优先从 runs/ 目录发现（参考 ca-viewer 的 runStateParser.ts），
 * 回退到旧 run-state/ 路径（兼容）
 *
 * @param {string} jsonlPath session JSONL 文件路径
 * @param {string} sessionId session ID
 * @param {string} [runId] 可选的 runId，用于直接定位 runs/{runId}/
 * @returns {{steps: Array, workflow: Object|null, runDir: string|null}} 步骤边界信息
 */
export function autoLoadStepBoundaries(jsonlPath, sessionId, runId = null) {
  // 优先从 runs/ 目录发现
  const runsDir = discoverRunsDir(jsonlPath, runId);
  if (runsDir) {
    const result = loadStepBoundaries(runsDir);
    return { ...result, runDir: runsDir };
  }

  // 回退到旧 run-state/ 路径
  const runStateDir = discoverRunStateDir(jsonlPath, sessionId);
  if (runStateDir) {
    const result = loadStepBoundaries(runStateDir);
    return { ...result, runDir: runStateDir };
  }

  return { steps: [], workflow: null, runDir: null };
}

/**
 * 从 trace/events.jsonl 提取步骤时间窗口
 * 参考 ca-viewer 的 runStateParser.extractStepTimestamps
 *
 * @param {string} eventsJsonl events.jsonl 文件内容
 * @returns {Record<string, {startedAt?: string, completedAt?: string}>} 步骤时间戳
 */
export function extractStepTimestamps(eventsJsonl) {
  const timestamps = {};
  const lines = eventsJsonl.split('\n').filter(Boolean);
  for (const line of lines) {
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      continue;
    }
    if (evt.kind === 'step' && evt.step?.id && evt.time) {
      const stepId = evt.step.id;
      if (!timestamps[stepId]) {
        timestamps[stepId] = {};
      }
      if (evt.event === 'started') {
        timestamps[stepId].startedAt = evt.time;
      } else if (evt.event === 'completed') {
        timestamps[stepId].completedAt = evt.time;
      }
    }
  }
  return timestamps;
}

/**
 * 构建步骤时间窗口（参考 ca-viewer 的 resolveTurnBindings.buildStepWindows）
 *
 * 将步骤事件折成时间窗口 [startAt, endAt)：
 * - 未闭合的窗口（有 started 无 completed）延伸到下一步 started 或正无穷
 * - 同一 stepId 允许多对 started/completed（重试形态）
 *
 * @param {Array<{stepId: string, startTs: string, endTs: string|null}>} steps 步骤列表
 * @returns {Array<{stepId: string, startAt: string, endAt: string|null}>} 时间窗口列表
 */
export function buildStepWindows(steps) {
  if (!steps || steps.length === 0) return [];

  // 按开始时间排序
  const sorted = [...steps]
    .filter(s => s.startTs)
    .sort((a, b) => new Date(a.startTs).getTime() - new Date(b.startTs).getTime());

  const windows = [];
  for (let i = 0; i < sorted.length; i++) {
    const step = sorted[i];
    let endAt = step.endTs || null;

    // 未闭合窗口：如果下一步已开始，用下一步的开始时间闭合
    if (endAt === null && i + 1 < sorted.length) {
      endAt = sorted[i + 1].startTs;
    }

    windows.push({
      stepId: step.stepId,
      startAt: step.startTs,
      endAt,
    });
  }

  return windows;
}
