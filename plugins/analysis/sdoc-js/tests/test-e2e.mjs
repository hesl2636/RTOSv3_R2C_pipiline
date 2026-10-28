// test-e2e.mjs — 端到端测试：验证 JS 版与 Python 版行为一致

import { run } from '../index.mjs';
import { loadTrace } from '../adapter.mjs';
import { sliceSession } from '../slicer.mjs';
import { runAll } from '../detectors.mjs';
import { compute } from '../metrics.mjs';
import { SessionWiki } from '../wiki.mjs';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const REAL_SESSION = join(homedir(), ".legacy-state", "projects", "D--8-13------v0", "ddc55d16-0aca-4a2d-af9d-23baf0694304.jsonl");

let passed = 0, failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.log(`  ✗ ${msg}`); }
}

// ---- Test 1: adapter 能加载真实 session ----
console.log("\n=== Test 1: adapter 加载真实 session ===");
if (!existsSync(REAL_SESSION)) {
  console.log("  ⚠ 跳过：未找到真实 session");
} else {
  const trace = loadTrace(REAL_SESSION);
  assert(trace.session_id.length > 0, "应解析出 session_id");
  assert(trace.tool === "codeagent", "tool 字段应为 codeagent");
  assert(trace.events.length > 0, "应有事件");
  assert(trace.bashEvents().length > 0, "应有 Bash 事件");
  assert(trace.total_input_tokens > 0, "应统计 input_tokens");

  console.log(`  session: ${trace.session_id.slice(0, 12)}`);
  console.log(`  events: ${trace.events.length}`);
  console.log(`  bash events: ${trace.bashEvents().length}`);
  console.log(`  skills available: ${trace.skills_available.length}`);
  console.log(`  skills used: ${trace.skills_used.length}`);
}

// ---- Test 2: adapter 跳过 CodeAgent 额外 type ----
console.log("\n=== Test 2: adapter 跳过额外 type ===");
{
  const tmpDir = join(process.cwd(), "tests", "tmp");
  mkdirSync(tmpDir, { recursive: true });
  const tmpFile = join(tmpDir, "test-skip-types.jsonl");
  const lines = [
    JSON.stringify({ type: "file-history-snapshot", messageId: "test", snapshot: {} }),
    JSON.stringify({ type: "ai-title", aiTitle: "Test" }),
    JSON.stringify({ type: "user", message: { role: "user", content: "hello" }, timestamp: "2024-01-01T00:00:00Z" }),
    JSON.stringify({ type: "last-prompt", lastPrompt: "test" }),
  ];
  writeFileSync(tmpFile, lines.join("\n") + "\n", "utf-8");
  const trace = loadTrace(tmpFile);
  const userEvents = trace.events.filter(e => e.role === "user");
  assert(userEvents.length === 1, "应只解析出 1 个 user 事件");
}

// ---- Test 3: adapter 忽略 thinking 块 ----
console.log("\n=== Test 3: adapter 忽略 thinking 块 ===");
{
  const tmpDir = join(process.cwd(), "tests", "tmp");
  mkdirSync(tmpDir, { recursive: true });
  const tmpFile = join(tmpDir, "test-thinking.jsonl");
  const lines = [
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Let me think..." },
          { type: "text", text: "Here is my response" },
        ],
        model: "test-model",
      },
      timestamp: "2024-01-01T00:00:00Z",
    }),
  ];
  writeFileSync(tmpFile, lines.join("\n") + "\n", "utf-8");
  const trace = loadTrace(tmpFile);
  const assistantEvents = trace.events.filter(e => e.role === "assistant");
  assert(assistantEvents.length === 1, "应只解析出 1 个 assistant 事件");
  assert(assistantEvents[0].text === "Here is my response", "应取 text 块内容");
}

// ---- Test 4: slicer 切片 ----
console.log("\n=== Test 4: slicer 切片 ===");
if (existsSync(REAL_SESSION)) {
  const trace = loadTrace(REAL_SESSION);
  const slices = sliceSession(trace);
  assert(slices.length > 0, "应产出切片");
  assert(slices.every(s => s.slice_id.length > 0), "每个切片应有 slice_id");
  assert(slices.every(s => s.clusters.length > 0), "每个切片应有 cluster 分类");
  console.log(`  slices: ${slices.length}`);
}

// ---- Test 5: detectors 18 个检测器 ----
console.log("\n=== Test 5: detectors 检测 ===");
if (existsSync(REAL_SESSION)) {
  const trace = loadTrace(REAL_SESSION);
  const slices = sliceSession(trace);
  const candidates = runAll(trace, slices);
  assert(candidates.length > 0, "应检出候选问题");
  const scenarios = new Set(candidates.map(c => c.scenario));
  console.log(`  candidates: ${candidates.length}`);
  console.log(`  scenarios hit: ${[...scenarios].sort().join(", ")}`);
  // 验证已知场景（当前 session 应检出 S1/S3/S7/S13/S14 等）
  assert(scenarios.has("S1"), "应检出 S1（运行时探测）");
  assert(scenarios.has("S13") || scenarios.has("S14"), "应检出 S13 或 S14");
}

// ---- Test 6: metrics 计算 ----
console.log("\n=== Test 6: metrics 计算 ===");
if (existsSync(REAL_SESSION)) {
  const trace = loadTrace(REAL_SESSION);
  const slices = sliceSession(trace);
  const candidates = runAll(trace, slices);
  const m = compute(trace, candidates);
  assert(m.total_tokens > 0, "total_tokens 应大于 0");
  assert(m.candidate_count === candidates.length, "candidate_count 应匹配");
  assert("exploration_tokens" in m, "应有 exploration_tokens");
  assert("repeated_failures" in m, "应有 repeated_failures");
  console.log(`  exploration_tokens: ${m.exploration_tokens}`);
  console.log(`  repeated_failures: ${m.repeated_failures}`);
  console.log(`  total_tokens: ${m.total_tokens}`);
}

// ---- Test 7: wiki 倒排索引 ----
console.log("\n=== Test 7: wiki 倒排索引 ===");
if (existsSync(REAL_SESSION)) {
  const trace = loadTrace(REAL_SESSION);
  const slices = sliceSession(trace);
  const wiki = new SessionWiki(slices);
  const c1Slices = wiki.clusterSlices("C1");
  assert(c1Slices.length > 0, "C1 cluster 应有切片");
  const retrieved = wiki.retrieve("C1", ["python"], 5);
  assert(Array.isArray(retrieved), "retrieve 应返回数组");
}

// ---- Test 8: 端到端 mock backend ----
console.log("\n=== Test 8: 端到端 mock backend ===");
if (existsSync(REAL_SESSION)) {
  const rep = await run(REAL_SESSION, { backend: "mock", doFix: true });
  assert(rep.session_id.length > 0, "应有 session_id");
  assert(rep.metrics.candidate_count > 0, "应有候选");
  assert(rep.confirmed_real > 0, "应有确认为 real 的问题");
  assert(rep.knowledge_blocks.length > 0, "应产出知识块");
  assert("knowledge_md_patch" in rep, "应有 knowledge_md_patch 字段");
  assert("auto_injected_path" in rep, "应有 auto_injected_path 字段");
  console.log(`  confirmed_real: ${rep.confirmed_real}`);
  console.log(`  knowledge_blocks: ${rep.knowledge_blocks.length}`);
}

// ---- Test 9: auto-inject 功能 ----
console.log("\n=== Test 9: auto-inject 功能 ===");
if (existsSync(REAL_SESSION)) {
  const tmpProject = join(process.cwd(), "tests", "tmp-project");
  const tmpOut = join(process.cwd(), "tests", "tmp-out");
  const rep = await run(REAL_SESSION, {
    backend: "mock", doFix: true,
    autoInject: true, projectRoot: tmpProject,
  });
  if (rep.knowledge_blocks.length > 0) {
    assert(rep.auto_injected_path !== null, "应返回注入路径");
    assert(existsSync(join(tmpProject, ".ai-knowledge.md")), ".ai-knowledge.md 应被创建");
    assert(existsSync(join(tmpProject, "AGENTS.md")), "AGENTS.md 应被创建");
    // 幂等性：再跑一次
    await run(REAL_SESSION, { backend: "mock", doFix: true, autoInject: true, projectRoot: tmpProject });
    const agentsContent = readFileSync(join(tmpProject, "AGENTS.md"), "utf-8");
    const refCount = (agentsContent.match(/\.ai-knowledge\.md/g) || []).length;
    assert(refCount === 1, "引用应只出现一次（幂等）");
  } else {
    console.log("  ⚠ 无知识块，跳过 auto-inject 验证");
  }
}

// ---- Test 10: model aliases ----
console.log("\n=== Test 10: model aliases ===");
import { callModel } from '../codeagent-client.mjs';
import { CodeAgentConfirmer } from '../confirmer.mjs';
import { CodeAgentFixer } from '../fixer.mjs';
assert(new CodeAgentConfirmer().model === "smallModel", "confirmer 默认 smallModel");
assert(new CodeAgentFixer().model === "mainModel", "fixer 默认 mainModel");

// ---- Summary ----
console.log(`\n=== 测试结果: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
