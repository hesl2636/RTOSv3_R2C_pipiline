// codeagent-client.mjs — 调用 CodeAgent CLI（无头模式）
// 对照 Python codeagent_client.py
// callModel 使用 spawnSync（同步阻塞），与 Python subprocess.run 行为一致；
// callModelAsync 使用 spawn + Promise，支持多 cluster 并发分析（reduce 总耗时）。

import { spawnSync, spawn } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export class ModelResult {
  constructor({ text = "", ok = false, input_tokens = 0, output_tokens = 0, cost_usd = 0.0, error = "" }) {
    Object.assign(this, { text, ok, input_tokens, output_tokens, cost_usd, error });
  }
}

export function callModel(prompt, model = "GLM-5.2-Auto(Volcano-MaaS)", timeout = 600) {
  // 把 prompt 写到临时文件，通过 stdin 管道传给 codeagent
  // 注意：不能用 $(cat 'file') 展开，因为 prompt 中的 --version / --project-root 等
  // 文本会被 codeagent 误认为命令行参数
  const tmpDir = mkdtempSync(join(tmpdir(), "sdoc-prompt-"));
  const promptFile = join(tmpDir, "prompt.txt");
  writeFileSync(promptFile, prompt, "utf-8");
  const safePath = promptFile.replace(/\\/g, "/");

  let stdout;
  try {
    // 用 bash -c 调用，通过 < 重定向从文件读取 stdin，避免命令行展开问题
    // 模型名称用双引号括起来，处理包含特殊字符（如括号）的模型名
    const script = `codeagent --output-format json --model "${model}" --skip-safe-check < '${safePath}'`;
    const result = spawnSync("bash", ["-c", script], {
      encoding: "utf-8",
      timeout: timeout * 1000,
      maxBuffer: 50 * 1024 * 1024,
      env: { ...process.env, LEGACY_CONFIG_DIR: process.env.LEGACY_CONFIG_DIR || `${process.env.HOME || process.env.USERPROFILE}/.legacy-state` },
    });
    if (result.error && result.error.code === "ETIMEDOUT") {
      return new ModelResult({ ok: false, error: "timeout" });
    }
    if (result.signal === "SIGTERM") {
      return new ModelResult({ ok: false, error: "timeout" });
    }
    stdout = result.stdout || "";
    // codeagent 非零退出时 stdout 可能包含 JSON（如 401 认证错误时仍返回 JSON）
    if (result.status !== 0 && !stdout) {
      const errMsg = (result.stderr || "").slice(0, 400) || `exit ${result.status}`;
      return new ModelResult({ ok: false, error: errMsg });
    }
  } catch (err) {
    return new ModelResult({ ok: false, error: (err.stderr || err.message || "").slice(0, 400) });
  } finally {
    try { unlinkSync(promptFile); } catch {}
  }

  let outer;
  try {
    outer = JSON.parse(stdout);
  } catch {
    // 非 json 也返回原文
    return new ModelResult({ text: stdout, ok: true });
  }

  const usage = outer.usage || {};
  return new ModelResult({
    text: outer.result || "",
    ok: !outer.is_error,
    input_tokens: parseInt(usage.input_tokens || 0) || 0,
    output_tokens: parseInt(usage.output_tokens || 0) || 0,
    cost_usd: parseFloat(outer.total_cost_usd || 0.0) || 0.0,
    error: outer.api_error_status || "",
  });
}

/** 解析 codeagent stdout → ModelResult（callModel 与 callModelAsync 共用） */
function _parseModelResult(stdout) {
  let outer;
  try {
    outer = JSON.parse(stdout);
  } catch {
    // 非 json 也返回原文
    return new ModelResult({ text: stdout, ok: true });
  }

  const usage = outer.usage || {};
  return new ModelResult({
    text: outer.result || "",
    ok: !outer.is_error,
    input_tokens: parseInt(usage.input_tokens || 0) || 0,
    output_tokens: parseInt(usage.output_tokens || 0) || 0,
    cost_usd: parseFloat(outer.total_cost_usd || 0.0) || 0.0,
    error: outer.api_error_status || "",
  });
}

/**
 * 异步调用 CodeAgent CLI（spawn + Promise），支持多 cluster 并发。
 * 与 callModel 语义一致（stdin 传 prompt、json 输出、超时），仅改异步。
 */
export function callModelAsync(prompt, model = "GLM-5.2-Auto(Volcano-MaaS)", timeout = 600) {
  return new Promise((resolve) => {
    const tmpDir = mkdtempSync(join(tmpdir(), "sdoc-prompt-"));
    const promptFile = join(tmpDir, "prompt.txt");
    try {
      writeFileSync(promptFile, prompt, "utf-8");
    } catch (err) {
      resolve(new ModelResult({ ok: false, error: String(err.message || err).slice(0, 400) }));
      return;
    }
    const safePath = promptFile.replace(/\\/g, "/");
    const script = `codeagent --output-format json --model "${model}" --skip-safe-check < '${safePath}'`;

    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn("bash", ["-c", script], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, LEGACY_CONFIG_DIR: process.env.LEGACY_CONFIG_DIR || `${process.env.HOME || process.env.USERPROFILE}/.legacy-state` },
    });
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch {}
      try { unlinkSync(promptFile); } catch {}
      resolve(new ModelResult({ ok: false, error: "timeout" }));
    }, timeout * 1000);

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { unlinkSync(promptFile); } catch {}
      resolve(new ModelResult({ ok: false, error: String(err.message || err).slice(0, 400) }));
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { unlinkSync(promptFile); } catch {}
      if (signal === "SIGTERM" || code === null) {
        resolve(new ModelResult({ ok: false, error: "timeout" }));
        return;
      }
      if (code !== 0 && !stdout) {
        resolve(new ModelResult({ ok: false, error: (stderr || `exit ${code}`).slice(0, 400) }));
        return;
      }
      resolve(_parseModelResult(stdout));
    });
  });
}

export function extractJson(text) {
  if (!text) return null;

  // 清理尾逗号：匹配 ,] 和 ,} 模式（包括中间有空白的情况）
  function sanitize(json) {
    return json.replace(/,\s*([\]}])/g, "$1");
  }

  // 尝试 code fence（用贪婪匹配到最后一个 ```，正确处理嵌套对象）
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) {
    const inner = fenceMatch[1].trim();
    if (inner.startsWith("{")) {
      try { return JSON.parse(sanitize(inner)); } catch {}
    }
  }

  // 找第一个平衡的大括号块
  let start = text.indexOf("{");
  while (start !== -1) {
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") {
        depth--;
        if (depth === 0) {
          const candidate = text.slice(start, i + 1);
          try { return JSON.parse(sanitize(candidate)); }
          catch { break; }
        }
      }
    }
    start = text.indexOf("{", start + 1);
  }
  return null;
}
