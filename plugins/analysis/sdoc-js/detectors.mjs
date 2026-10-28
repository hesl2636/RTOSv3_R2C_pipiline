// detectors.mjs — 18 个检测器（S1-S18）
// 对照 Python detectors.py

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Candidate } from './model.mjs';

// ---- 阈值 ----
const TH_PROBE = 3;
const TH_EARLY_EXPLORE = 5;
const TH_GIT_FAIL = 2;
const TH_REREAD = 3;
const TH_EMPTY_SEARCH = 2;
const TH_ENV_PROBE = 2;
const TH_MISSING_RETRY = 2;
const TH_UNUSED_SKILLS = 1;

// ---- 正则 ----
const PROBE_RE = /\b(which|whereis|type)\b|--version|(^|\s)-v($|\s)|\bversion\b/i;
// 探测类命令排除项：pytest -v 等测试/构建命令的 -v 是 verbose 标志，不是版本探测。
// 若命令匹配 TEST_RE/BUILD_RE（测试/构建），不算运行时探测（避免误报）。
// 注意：需在 TEST_RE/BUILD_RE 之后定义（这些常量在其下方声明，这里用函数延迟引用）。
const _isTestOrBuildCmd = (cmd) => {
  try {
    return TEST_RE.test(cmd) || BUILD_RE.test(cmd);
  } catch { return false; }
};
const ENV_PROBE_RE = /^\s*(echo\s+\$\w+|printenv\b|env\b|export\b.*\?\s*$|echo\s+["']\$\{?\w+\}?|python3?\s+-c\s+["'].*os\.environ|node\s+-e\s+["'].*process\.env)/gim;
const BUILD_RE = /\b(cargo build|go build|make\b|cmake\b|ninja\b|bazel build|buck build|npm run build|pnpm(?: run)? build|yarn(?: run)? build|bun run build|tsc\b|webpack|vite build|rollup|esbuild|python -m build|setup\.py (?:build|install)|pip install|poetry (?:build|install)|hatch build|pdm build|dotnet build|msbuild|mvn\b|gradle\b|\.\/gradlew|\.\/mvnw|sbt\b|composer install|bundle install|rake build)\b/i;
const TEST_RE = /\b(cargo test|go test|ctest\b|bazel test|pytest|python -m (?:unittest|pytest)|unittest|tox\b|nox\b|npm(?: run)? test|pnpm(?: run)? test|yarn(?: run)? test|bun test|jest|vitest|mocha|playwright test|dotnet test|mvn (?:test|verify)|gradle test|\.\/gradlew test|\.\/mvnw test|sbt test|rspec|rake test|bundle exec rspec|phpunit|go-test)\b/i;
const LINT_RE = /\b(clippy|cargo (?:fmt|clippy)|rustfmt|gofmt|go vet|golangci-lint|staticcheck|eslint|prettier|biome\b|tsc --noemit|ruff|flake8|black\b|isort|mypy|pyright|pylint|pycodestyle|dotnet format|checkstyle|spotless|ktlint|detekt|rubocop|standardrb|phpcs|php-cs-fixer|npm run lint|pnpm(?: run)? lint|yarn(?: run)? lint)\b/i;
const GIT_RE = /\bgit\b/i;
const SEARCH_TOOLS = new Set(["Grep", "Glob"]);

const KW = {
  S8_cmd: ["command not found", "unknown command", "not recognized", "no such command"],
  S8_arg: ["invalid option", "unrecognized argument", "illegal option", "bad option", "unknown flag"],
  S9_dep: ["npm err!", "could not resolve", "enotfound", "pip install failed", "cargo build error", "e: unable to locate", "no matching distribution", "could not find a version"],
  S9_perm: ["eacces", "permission denied", "operation not permitted", "eperm"],
  S9_net: ["econnrefused", "etimedout", "network unreachable", "fetch failed", "enetunreach", "connection refused", "certificate_verify_failed", "ssl: "],
  S9_env: ["env var not found", "not set", "missing env", "is not defined", "environment variable", "unbound variable", "must be set", "required env", "keyerror", "os.environ", "process.env", "no value for", "undefined env"],
  S10_mod: ["cannot find module", "unresolved import", "module not found", "modulenotfounderror", "no such file or directory", "importerror", "cannot find name", "unresolved reference"],
  S17_extract: [
    /command not found[:\s]+['"]?(\S+?)['"]?/i,
    /cannot find module ['"]([^'"]+)['"]/i,
    /no such file or directory[:\s]+['"]?([^\s'"]+)['"]?/i,
    /could not resolve[: ]+['"]?([^\s'"]+)['"]?/i,
    /no matching distribution found for ([^\s;]+)/i,
    /modulenotfounderror: no module named ['"]([^'"]+)['"]/i,
    /e: unable to locate packages?\s+([^\s]+)/i,
    /error\[e\d+\]: unresolved import `([^`]+)`/i,
  ],
};

const EXCLUDE_S9_ENV = ["undefined is not a function", "is not defined at"];
const _WRONG_READ = new Set(["cat", "head", "tail", "sed", "awk"]);
const _WRONG_SEARCH = new Set(["grep", "find", "rg", "ag"]);
const VERIFY_RE = new RegExp(BUILD_RE.source + "|" + TEST_RE.source + "|" + LINT_RE.source, "i");

// ---- 工具函数 ----
function _normErr(text) {
  if (!text) return "";
  let line = "";
  for (const l of text.split("\n")) {
    const ll = l.toLowerCase();
    if (ll.includes("error") || ll.includes("err!") || ll.includes("failed") || ll.includes("panic")) {
      line = l;
      break;
    }
  }
  if (!line) {
    const lines = text.split("\n");
    line = lines[0] || "";
  }
  line = line.replace(/\d+/g, "#");
  line = line.replace(/0x[0-9a-f]+/gi, "#");
  line = line.replace(/[/\\][\w./\\-]+/g, "PATH");
  return line.trim().toLowerCase().slice(0, 120);
}

function _seqToSlice(slices) {
  const m = {};
  for (const s of slices) {
    for (const e of s.events) {
      m[e.seq] = s.slice_id;
    }
  }
  return m;
}

function _sliceIds(seqs, s2s) {
  const result = new Set();
  for (const q of seqs) {
    if (q in s2s) result.add(s2s[q]);
  }
  return [...result].sort();
}

function _estTokens(events) {
  return events.reduce((s, e) => s + e.output_tokens + Math.floor((e.tool_output || "").length / 4), 0);
}

// 浪费时长估算（秒）：events 首尾 ts 差值。
// 用于量化"试错/探测/重复失败"等场景的墙钟时间浪费。
// 浪费时长估算（秒）：首事件发起 ts → 末事件完成 resultTs 的端到端跨度。
// 用于量化"试错/探测/重复失败"等场景用户实际额外等待的墙钟时间。
// 关键：必须用 resultTs（tool_result 完成时刻）而非 ts（tool_use 发起时刻），
// 否则并发执行的多次调用（如 5 次 python 失败几乎同时发起但逐个完成）会严重低估——
// 发起时刻相近但完成时刻逐次延后，真实等待时长 = 首发起 → 末完成。
// 单个 event 或无 ts 时回退为 0。
function _estTime(events) {
  if (!events || events.length === 0) return 0;
  // 起点取首事件发起 ts；终点取末事件完成 resultTs（无 resultTs 时回退 ts）
  const starts = events.map(e => e.ts).filter(Boolean).sort();
  const ends = events.map(e => e.resultTs || e.ts).filter(Boolean).sort();
  if (starts.length === 0 || ends.length === 0) return 0;
  const start = new Date(starts[0]).getTime();
  const end = new Date(ends[ends.length - 1]).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return Math.round((end - start) / 1000);
}

function _kwHits(trace, keys, exclude = null) {
  const out = [];
  for (const e of trace.tool_calls) {
    if (!e.is_error || !e.tool_output) continue;
    const low = e.tool_output.toLowerCase();
    if (exclude && exclude.some(x => low.includes(x))) continue;
    if (keys.some(k => low.includes(k))) out.push(e);
  }
  return out;
}

// ---- S1 运行时探测 ----
function detectS1(trace, slices, s2s) {
  // 排除测试/构建命令（pytest -v 等）：-v/--cov 是测试标志不是版本探测。
  // 只有非测试/构建上下文中的 which/--version/-v 才算运行时探测。
  const hits = trace.bashEvents().filter(e =>
    PROBE_RE.test(e.command) && !_isTestOrBuildCmd(e.command)
  );
  if (hits.length < TH_PROBE) return [];
  return [new Candidate("S1", "C1",
    `session 出现 ${hits.length} 次运行时探测命令（which/--version 等）`,
    { count: hits.length },
    _sliceIds(hits.map(e => e.seq), s2s),
    _estTokens(hits), _estTime(hits))];
}

// ---- S2 结构探索 ----
function detectS2(trace, slices, s2s) {
  const total = slices.length;
  if (total < TH_EARLY_EXPLORE) return [];
  let early = slices.slice(0, Math.max(1, Math.floor(total / 5)));
  if (early.length < TH_EARLY_EXPLORE) early = slices.slice(0, TH_EARLY_EXPLORE);
  if (early.every(s => (s.call_type === "search" || s.call_type === "file_op") && !s.produced_code)) {
    return [new Candidate("S2", "C1",
      `前段 ${early.length} 个切片全是探索（search/read）且零代码产出`,
      { early_slices: early.length },
      early.map(s => s.slice_id),
      early.reduce((s, x) => s + x.token_cost, 0), _estTime(early.flatMap(s => s.events || [])))];
  }
  return [];
}

// ---- S3 命令试错 ----
function detectS3(trace, slices, s2s) {
  const intents = { build: BUILD_RE, test: TEST_RE, lint: LINT_RE };
  const out = [];
  for (const [intent, rx] of Object.entries(intents)) {
    const evs = trace.bashEvents().filter(e => rx.test(e.command));
    const distinct = new Set(evs.map(e => e.command.trim()));
    if (distinct.size >= 2 && evs.some(e => e.is_error)) {
      out.push(new Candidate("S3", "C1",
        `${intent} 命令试错：${distinct.size} 种不同写法且有失败`,
        { intent, distinct_cmds: distinct.size },
        _sliceIds(evs.map(e => e.seq), s2s),
        _estTokens(evs), _estTime(evs)));
    }
  }
  return out;
}

// ---- S4 git 失败 ----
function detectS4(trace, slices, s2s) {
  const fails = trace.bashEvents().filter(e => GIT_RE.test(e.command) && e.is_error);
  if (fails.length < TH_GIT_FAIL) return [];
  const sub = {};
  for (const e of fails) {
    const parts = e.command.replace(/\s+/g, " ").split(" ");
    const k = parts.length > 1 ? parts[1] : "git";
    sub[k] = (sub[k] || 0) + 1;
  }
  return [new Candidate("S4", "C2",
    `git 命令失败 ${fails.length} 次（${JSON.stringify(sub)}）`,
    { fail_count: fails.length, by_sub: sub },
    _sliceIds(fails.map(e => e.seq), s2s),
    _estTokens(fails), _estTime(fails))];
}

// ---- S5 构建同一错误 ----
function detectS5(trace, slices, s2s) {
  const evs = trace.bashEvents().filter(e => BUILD_RE.test(e.command) && e.is_error);
  const sigs = {};
  for (const e of evs) {
    const sig = _normErr(e.tool_output || "");
    if (!sigs[sig]) sigs[sig] = [];
    sigs[sig].push(e);
  }
  const out = [];
  for (const [sig, group] of Object.entries(sigs)) {
    if (sig && group.length >= 2) {
      out.push(new Candidate("S5", "C2",
        `构建因同一错误重复失败 ${group.length} 次: ${sig.slice(0, 60)}`,
        { repeat: group.length, sig },
        _sliceIds(group.map(e => e.seq), s2s),
        _estTokens(group), _estTime(group)));
    }
  }
  return out;
}

// ---- S6 lint 循环 ----
function detectS6(trace, slices, s2s) {
  const tags = [];
  for (const e of trace.events) {
    if (e.type !== "tool_call") continue;
    if (e.tool_name === "Bash" && LINT_RE.test(e.command)) {
      tags.push(["lint", e.seq]);
    } else if (["Edit", "Write", "NotebookEdit"].includes(e.tool_name)) {
      tags.push(["edit", e.seq]);
    }
  }
  const labels = tags.map(t => t[0]);
  let cycles = 0;
  const seqs = [];
  let i = 0;
  while (i < labels.length) {
    if (labels[i] === "lint") {
      let j = i + 1;
      let sawEdit = false;
      let found = false;
      while (j < labels.length) {
        if (labels[j] === "edit") sawEdit = true;
        else if (labels[j] === "lint" && sawEdit) {
          cycles++;
          seqs.push(tags[i][1], tags[j][1]);
          i = j;
          found = true;
          break;
        }
        j++;
      }
      if (found) continue;
      break;
    }
    i++;
  }
  if (cycles >= 2) {
    return [new Candidate("S6", "C2",
      `lint→edit→lint 循环 ${cycles} 次（本可先跑 formatter）`,
      { cycles },
      _sliceIds(seqs, s2s))];
  }
  return [];
}

// ---- S7 测试反复失败 ----
function detectS7(trace, slices, s2s) {
  const evs = trace.bashEvents().filter(e => TEST_RE.test(e.command) && e.is_error);
  const byc = {};
  for (const e of evs) {
    const cmd = e.command.trim();
    if (!byc[cmd]) byc[cmd] = [];
    byc[cmd].push(e);
  }
  const out = [];
  for (const [cmd, group] of Object.entries(byc)) {
    if (group.length >= 2) {
      out.push(new Candidate("S7", "C2",
        `同一测试命令反复失败 ${group.length} 次: ${cmd.slice(0, 50)}`,
        { repeat: group.length },
        _sliceIds(group.map(e => e.seq), s2s),
        _estTokens(group), _estTime(group)));
    }
  }
  return out;
}

// ---- S8 命令不存在 ----
function detectS8(trace, slices, s2s) {
  const out = [];
  const cmdHits = _kwHits(trace, KW.S8_cmd);
  // exit 126/127 = command not found / not executable
  // exit 49 = Windows Store 占位 stub（python/python3 应用别名，无实际解释器）
  // 排除探测类命令（which/--version 等，属 S1 运行时探测场景）：
  // 探测命令失败（如 which 找不到）是"探测环境"，不是"命令不存在试错"，
  // 不排除会让 S8 与 S1 事件重叠、时间/ token 被无关探测事件拉长。
  const PROBE_RE_S8 = /\b(which|whereis|type)\b|--version|(^|\s)-v($|\s)|\bversion\b/i;
  const exitHits = trace.bashEvents().filter(e =>
    (e.exit_code === 126 || e.exit_code === 127 || e.exit_code === 49) &&
    !PROBE_RE_S8.test(e.command)
  );
  const allCmd = {};
  for (const e of [...cmdHits, ...exitHits]) allCmd[e.seq] = e;
  if (Object.keys(allCmd).length > 0) {
    const evs = Object.values(allCmd);
    out.push(new Candidate("S8", "C3", `命令不存在/不可执行 ${evs.length} 次`,
      { kind: "command_not_found", count: evs.length },
      _sliceIds(Object.keys(allCmd).map(Number), s2s),
      _estTokens(evs), _estTime(evs)));
  }
  const argHits = _kwHits(trace, KW.S8_arg);
  if (argHits.length > 0) {
    out.push(new Candidate("S8", "C3", `命令参数错误 ${argHits.length} 次`,
      { kind: "bad_argument", count: argHits.length },
      _sliceIds(argHits.map(e => e.seq), s2s),
      _estTokens(argHits), _estTime(argHits)));
  }
  return out;
}

// ---- S9 依赖/权限/网络/env ----
function detectS9(trace, slices, s2s) {
  const out = [];
  const kinds = [["dependency", KW.S9_dep], ["permission", KW.S9_perm],
                 ["network", KW.S9_net], ["env_var", KW.S9_env]];
  for (const [kind, keys] of kinds) {
    const excl = kind === "env_var" ? EXCLUDE_S9_ENV : null;
    const hits = _kwHits(trace, keys, excl);
    if (hits.length > 0) {
      out.push(new Candidate("S9", "C3", `${kind} 错误 ${hits.length} 次`,
        { kind, count: hits.length },
        _sliceIds(hits.map(e => e.seq), s2s),
        _estTokens(hits), _estTime(hits)));
    }
  }
  return out;
}

// ---- S10 import 找不到 ----
function detectS10(trace, slices, s2s) {
  const hits = _kwHits(trace, KW.S10_mod);
  const readMiss = trace.byTool("Read").filter(e => e.is_error && e.tool_output && e.tool_output.toLowerCase().includes("no such file"));
  const allh = {};
  for (const e of [...hits, ...readMiss]) allh[e.seq] = e;
  if (Object.keys(allh).length > 0) {
    const evs = Object.values(allh);
    return [new Candidate("S10", "C3", `import/模块/路径找不到 ${evs.length} 次`,
      { count: evs.length },
      _sliceIds(Object.keys(allh).map(Number), s2s),
      _estTokens(evs), _estTime(evs))];
  }
  return [];
}

// ---- S11 重复读文件 ----
function detectS11(trace, slices, s2s) {
  const reads = {};
  for (const e of trace.byTool("Read")) {
    for (const p of (e.file_paths || [])) {
      if (!reads[p]) reads[p] = [];
      reads[p].push(e);
    }
  }
  const out = [];
  for (const [path, evs] of Object.entries(reads)) {
    if (evs.length >= TH_REREAD) {
      // 检查两次读之间是否有 Edit/Write
      const edited = trace.events.some(x =>
        ["Edit", "Write"].includes(x.tool_name) &&
        (x.file_paths || []).includes(path) &&
        evs[0].seq < x.seq && x.seq < evs[evs.length - 1].seq
      );
      if (edited) continue;
      out.push(new Candidate("S11", "C4", `文件被重复读取 ${evs.length} 次: ${path}`,
        { path, count: evs.length },
        _sliceIds(evs.map(e => e.seq), s2s),
        _estTokens(evs.slice(1)), _estTime(evs.slice(1))));
    }
  }
  return out;
}

// ---- S12 空搜索连环 ----
function _isEmptySearch(e) {
  if (!SEARCH_TOOLS.has(e.tool_name)) return false;
  const o = (e.tool_output || "").trim().toLowerCase();
  return e.is_error || o === "" || o.includes("no matches") || o.includes("no files found") || o.startsWith("found 0");
}

function detectS12(trace, slices, s2s) {
  const searches = trace.tool_calls.filter(e => SEARCH_TOOLS.has(e.tool_name));
  let run = 0, best = 0;
  const seqs = [];
  let cur = [];
  for (const e of searches) {
    if (_isEmptySearch(e)) {
      run++;
      cur.push(e.seq);
      best = Math.max(best, run);
    } else {
      if (run >= TH_EMPTY_SEARCH) seqs.push(...cur);
      run = 0;
      cur = [];
    }
  }
  if (run >= TH_EMPTY_SEARCH) seqs.push(...cur);
  if (best >= TH_EMPTY_SEARCH) {
    return [new Candidate("S12", "C4", `连续空搜索 ${best} 次（盲猜关键词）`,
      { max_streak: best },
      _sliceIds(seqs, s2s),
      0, _estTime(searches))];
  }
  return [];
}

// ---- S13 Edit 失败重试 ----
function detectS13(trace, slices, s2s) {
  const fails = trace.events.filter(e => ["Edit", "NotebookEdit"].includes(e.tool_name) && e.is_error);
  if (fails.length === 0) return [];
  let retried = 0;
  for (const e of fails) {
    if (trace.events.some(x =>
      ["Edit", "Write", "NotebookEdit"].includes(x.tool_name) && x.seq > e.seq &&
      new Set([...(x.file_paths || []), ...(e.file_paths || [])]).size < (x.file_paths || []).length + (e.file_paths || []).length
    )) {
      retried++;
    }
  }
  return [new Candidate("S13", "C2",
    `Edit 编辑失败 ${fails.length} 次（old_string 不匹配等），重试 ${retried} 次`,
    { fail_count: fails.length, retried },
    _sliceIds(fails.map(e => e.seq), s2s),
    _estTokens(fails), _estTime(fails))];
}

// ---- S14 工具误用 ----
function _primaryCmds(cmd) {
  const toks = [];
  for (const s of cmd.split(/&&|\|\||;|\|/)) {
    const parts = s.trim().split(/\s+/);
    if (parts.length > 0 && parts[0]) toks.push(parts[0]);
  }
  return toks;
}

function detectS14(trace, slices, s2s) {
  const readMisuse = [], searchMisuse = [];
  for (const e of trace.bashEvents()) {
    const toks = _primaryCmds(e.command);
    if (toks.length === 0) continue;
    const primary = toks[0];
    if (_WRONG_READ.has(primary)) readMisuse.push(e);
    else if (_WRONG_SEARCH.has(primary)) searchMisuse.push(e);
    else if (primary === "echo" && e.command.includes(">")) readMisuse.push(e);
  }
  const out = [];
  if (readMisuse.length > 0) {
    const kinds = [...new Set(readMisuse.map(e => _primaryCmds(e.command)[0]))].sort().join(",");
    out.push(new Candidate("S14", "C4",
      `用 bash(${kinds}) 读/改文件，应使用 Read/Edit（${readMisuse.length} 次）`,
      { kind: "file_via_bash", count: readMisuse.length },
      _sliceIds(readMisuse.map(e => e.seq), s2s),
      _estTokens(readMisuse), _estTime(readMisuse)));
  }
  if (searchMisuse.length > 0) {
    out.push(new Candidate("S14", "C4",
      `用 bash(grep/find) 搜索，应使用 Grep/Glob（${searchMisuse.length} 次）`,
      { kind: "search_via_bash", count: searchMisuse.length },
      _sliceIds(searchMisuse.map(e => e.seq), s2s),
      _estTokens(searchMisuse), _estTime(searchMisuse)));
  }
  return out;
}

// ---- S15 无验证声称完成 ----
function detectS15(trace, slices, s2s) {
  const produced = trace.events.filter(e => ["Write", "Edit", "NotebookEdit"].includes(e.tool_name));
  if (produced.length === 0) return [];
  // Check if there's a verification command AFTER the last edit
  const lastEditSeq = Math.max(...produced.map(e => e.seq));
  const verifyAfterEdit = trace.bashEvents().some(e => e.seq > lastEditSeq && VERIFY_RE.test(e.command));
  if (verifyAfterEdit) return [];
  const unverified = produced.filter(e => e.seq >= lastEditSeq);
  return [new Candidate("S15", "C2",
    `产出 ${produced.length} 处代码改动但最后编辑后未见任何 test/build/lint 验证`,
    { edits: produced.length, verify_calls: 0 },
    _sliceIds(unverified.slice(0, 5).map(e => e.seq), s2s))];
}

// ---- S16 环境变量探测 ----
function detectS16(trace, slices, s2s) {
  const hits = trace.bashEvents().filter(e => ENV_PROBE_RE.test(e.command));
  if (hits.length < TH_ENV_PROBE) return [];
  return [new Candidate("S16", "C1",
    `session 出现 ${hits.length} 次环境变量探测命令（echo $VAR/printenv/env 等）`,
    { count: hits.length, commands: hits.slice(0, 5).map(e => e.command.trim().slice(0, 60)) },
    _sliceIds(hits.map(e => e.seq), s2s),
    _estTokens(hits), _estTime(hits))];
}

// ---- S17 缺失资源反复重试 ----
function _extractMissingResource(text) {
  if (!text) return null;
  const low = text.toLowerCase();
  for (const rx of KW.S17_extract) {
    const m = low.match(rx);
    if (m) {
      // 取最后一个捕获组
      const name = m[m.length - 1] || m[1] || "";
      const trimmed = name.trim().replace(/^['"]|['"]$/g, "");
      if (trimmed && trimmed.length > 1) return trimmed.slice(0, 80);
    }
  }
  return null;
}

function detectS17(trace, slices, s2s) {
  const resourceHits = {};
  for (const e of trace.tool_calls) {
    if (!e.is_error || !e.tool_output) continue;
    if (e.exit_code === 127 && e.command) {
      const name = e.command.trim().split(/\s+/)[0];
      if (!resourceHits[name]) resourceHits[name] = [];
      resourceHits[name].push(e);
      continue;
    }
    const name = _extractMissingResource(e.tool_output);
    if (name) {
      if (!resourceHits[name]) resourceHits[name] = [];
      resourceHits[name].push(e);
    }
  }
  const out = [];
  for (const [resource, evs] of Object.entries(resourceHits)) {
    if (evs.length >= TH_MISSING_RETRY) {
      out.push(new Candidate("S17", "C3",
        `缺失资源 \`${resource}\` 引发 ${evs.length} 次错误（AI 反复重试未解决）`,
        { resource, error_count: evs.length },
        _sliceIds(evs.map(e => e.seq), s2s),
        _estTokens(evs), _estTime(evs)));
    }
  }
  return out;
}

// ---- S18 未使用 skill ----
function detectS18(trace, slices, s2s) {
  const available = new Set(trace.skills_available);
  const used = new Set(trace.skills_used);
  const unused = [...available].filter(x => !used.has(x)).sort();
  if (unused.length < TH_UNUSED_SKILLS) return [];
  const est = unused.length * 600;
  return [new Candidate("S18", "C1",
    `加载了 ${available.size} 个 skill，其中 ${unused.length} 个整个 session 未调用` +
    `（${unused.slice(0, 5).join(", ")}${unused.length > 5 ? "…" : ""}）`,
    {
      available: [...available].sort(),
      used: [...used].sort(),
      unused,
      unused_count: unused.length,
    },
    [],
    est)];
}

// ---- S19 Skill 调用后报错（偏差检测·类型1）----
function detectS19(trace, slices, s2s) {
  const skillErrors = trace.byTool("Skill").filter(e => e.is_error);
  if (skillErrors.length === 0) return [];
  const skillNames = [...new Set(skillErrors.map(e => (e.tool_input || {}).skill || "unknown"))];
  return [new Candidate("S19", "C3",
    `Skill 调用报错 ${skillErrors.length} 次（${skillNames.join(", ")}）`,
    { count: skillErrors.length, skills: skillNames },
    _sliceIds(skillErrors.map(e => e.seq), s2s),
    _estTokens(skillErrors), _estTime(skillErrors))];
}

// ---- S20 MCP 工具调用后报错（偏差检测·类型1）----
function detectS20(trace, slices, s2s) {
  const mcpErrors = trace.tool_calls.filter(e =>
    e.tool_name && e.tool_name.startsWith("mcp__") && e.is_error
  );
  if (mcpErrors.length === 0) return [];
  const mcpTools = [...new Set(mcpErrors.map(e => e.tool_name))];
  return [new Candidate("S20", "C3",
    `MCP 工具调用报错 ${mcpErrors.length} 次（${mcpTools.slice(0, 5).join(", ")}${mcpTools.length > 5 ? "…" : ""}）`,
    { count: mcpErrors.length, tools: mcpTools },
    _sliceIds(mcpErrors.map(e => e.seq), s2s),
    _estTokens(mcpErrors), _estTime(mcpErrors))];
}

// ---- S21 包管理安装试错（pip/npm/pnpm/cargo install/add 多写法）----
const PKG_INSTALL_RE = /\b(pip(?:3)? install|python -m pip install|npm install|npm i\b|pnpm(?: add| install)|yarn(?: add)?\b|bun add|poetry (?:add|install)|pipenv install|cargo (?:add|install)|go get|gem install|apt(?:-get)? install|brew install|composer require|bundle add)\b/i;
function detectS21(trace, slices, s2s) {
  const evs = trace.bashEvents().filter(e => PKG_INSTALL_RE.test(e.command));
  const distinct = new Set(evs.map(e => e.command.trim()));
  if (distinct.size >= 2 && evs.some(e => e.is_error)) {
    return [new Candidate("S21", "C3",
      `包管理安装试错：${distinct.size} 种不同写法且有失败`,
      { distinct_cmds: distinct.size },
      _sliceIds(evs.map(e => e.seq), s2s),
      _estTokens(evs), _estTime(evs))];
  }
  return [];
}

// ---- S22 配置/初始化探测（.env/config/rc 文件路径试错）----
const CONFIG_PROBE_RE = /(\.env(?:\.\w+)?|\.bashrc|\.zshrc|\.profile|settings\.json|config\.ya?ml|config\.json|tsconfig|pyproject\.toml|package\.json|requirements\.txt|CMakeLists|Makefile|\.gitignore|rc\b)/i;
function detectS22(trace, slices, s2s) {
  const evs = trace.bashEvents().filter(e =>
    CONFIG_PROBE_RE.test(e.command) && /(cat|less|tail|head|ls|find|grep|sed|vim|nano|touch|write)/i.test(e.command)
  );
  const distinct = new Set(evs.map(e => e.command.trim()));
  if (distinct.size >= 2 && evs.some(e => e.is_error)) {
    return [new Candidate("S22", "C3",
      `配置/初始化文件探测：${distinct.size} 种路径尝试且有失败`,
      { distinct_cmds: distinct.size },
      _sliceIds(evs.map(e => e.seq), s2s),
      _estTokens(evs), _estTime(evs))];
  }
  return [];
}

// ---- S23 工具链/编译配置试错（cmake/configure/make setup 命令试错）----
const TOOLCHAIN_RE = /\b(cmake\b|cmake -S|cmake --build|configure|\.\/configure|make setup|make configure|make distclean|bazel configure|meson setup|qmake|autoreconf|autoconf|config\.guess|pkg-config|ldconfig|setuptools|python setup\.py)\b/i;
function detectS23(trace, slices, s2s) {
  const evs = trace.bashEvents().filter(e => TOOLCHAIN_RE.test(e.command));
  const distinct = new Set(evs.map(e => e.command.trim()));
  if (distinct.size >= 2 && evs.some(e => e.is_error)) {
    return [new Candidate("S23", "C1",
      `工具链/编译配置试错：${distinct.size} 种写法且有失败`,
      { distinct_cmds: distinct.size },
      _sliceIds(evs.map(e => e.seq), s2s),
      _estTokens(evs), _estTime(evs))];
  }
  return [];
}

// ---- S24/S25/S26 共用：步骤 prompt 证据 + 相关调用失败日志 ----
// 步骤 prompt 来源优先级：内嵌 stepPrompt → 外置 taskFile（<pluginRoot>/tasks/<stepId>.md）
function _stepPromptSnippet(step, pluginRoot, maxLen = 900) {
  if (step.stepPrompt) return step.stepPrompt.slice(0, maxLen);
  if (step.taskFile && pluginRoot) {
    try {
      const content = readFileSync(join(pluginRoot, step.taskFile), "utf-8");
      return `[已读取任务文件 ${step.taskFile}] ${content.slice(0, maxLen)}`;
    } catch (e) {
      return `[任务文件 ${step.taskFile} 读取失败: ${e.message}]`;
    }
  }
  return "(步骤 prompt 不可见：未内嵌且无 taskFile)";
}

function _relatedFailures(trace, matchFn) {
  return (trace.tool_calls || [])
    .filter(e => e.tool_name && matchFn(e.tool_name, e.tool_input || {}) && e.is_error)
    .slice(0, 5)
    .map(e => `${e.tool_name}: ${String(e.error || e.result || "error").slice(0, 140)}`);
}

function _relatedCalls(trace, matchFn) {
  return (trace.tool_calls || []).filter(e => e.tool_name && matchFn(e.tool_name, e.tool_input || {}));
}

// 读取 skill 的 SKILL.md 摘要（frontmatter description + 正文前几行），
// 供 S24 生成"如何在步骤 prompt 中引导调用该 skill"的修复建议。
function _skillSummary(skillName, pluginRoot, maxLen = 240) {
  if (!skillName || !pluginRoot) return "";
  try {
    // 候选路径：插件 skills/<name>/SKILL.md（可能带插件前缀，去掉冒号前缀）
    const bare = skillName.includes(":") ? skillName.slice(skillName.indexOf(":") + 1) : skillName;
    const candidates = [
      join(pluginRoot, "skills", bare, "SKILL.md"),
      join(pluginRoot, "skills", bare, "skill.md"),
    ];
    for (const p of candidates) {
      if (!existsSync(p)) continue;
      const content = readFileSync(p, "utf-8");
      // 提取 frontmatter description
      const fm = content.match(/^---\s*\n([\s\S]*?)\n---/);
      let desc = "";
      if (fm) {
        const d = fm[1].match(/description:\s*(.+)/);
        if (d) desc = d[1].trim();
      }
      // 正文前 200 字（去掉 markdown 标题符号）
      const body = content
        .replace(/^---\s*\n[\s\S]*?\n---\s*\n/, "")
        .replace(/[#*`>]/g, "")
        .trim()
        .slice(0, maxLen);
      return desc ? `${desc}${body ? "；" + body : ""}`.slice(0, maxLen) : body;
    }
  } catch {}
  return "";
}

// ---- S24 配置了 skill 但未执行 ----
// 按每个未调用的 skill 拆分为独立 candidate；cluster 按步骤区分
// （同一步骤的多个 skill 共享一次 LLM 调用，避免全部候选挤在单 cluster 导致 prompt 超长超时）。
function detectS24(trace, slices, s2s, workflow) {
  const steps = workflow && Array.isArray(workflow.steps) ? workflow.steps : [];
  if (steps.length === 0) return [];
  // trace.skills_used 里的 skill 名可能带插件前缀（如 "gaussdb-dev-cjy0903:comet-open"），
  // configuredSkills 里的名字不带前缀（如 "comet-open"）。统一取冒号后部分做比对。
  const stripPluginPrefix = (s) => (typeof s === "string" && s.includes(":") ? s.slice(s.indexOf(":") + 1) : s);
  const pluginRoot = workflow.pluginRoot || null;
  const stepPrompts = {};
  const candidates = [];
  for (const step of steps) {
    // 检测范围 = configuredSkills + 主 skill 字段（step.skill）。
    // 主 skill（如 csi-ar-review）只出现在 `skill:` 字段，configuredSkills 只列辅助能力，
    // 之前漏掉主 skill 导致"配置了主 skill 但未调用"的场景检测不到。
    const names = [...new Set([...(step.configuredSkills || []), ...(step.skill ? [step.skill] : [])])];
    if (names.length === 0) continue;
    if (!stepPrompts[step.name]) stepPrompts[step.name] = _stepPromptSnippet(step, pluginRoot);
    // 按 step 时间窗口判断 skill 是否在该 step 内被调用（而非全局 skills_used）：
    // 同一 skill 在其他 step 调用过不代表本 step 已调用，每个 step 独立判断。
    const stepStart = step.startTs ? Date.parse(step.startTs) : NaN;
    const stepEnd = step.endTs ? Date.parse(step.endTs) : NaN;
    const inStepWindow = (e) => {
      if (!e.ts) return false;
      const t = Date.parse(e.ts);
      if (!Number.isFinite(t)) return false;
      // 无 startTs 时退化为全局判断（兼容无时间戳场景）
      if (!Number.isFinite(stepStart)) return true;
      // 有 start 无 end：窗口为 [start, +∞)
      if (!Number.isFinite(stepEnd)) return t >= stepStart;
      return t >= stepStart && t <= stepEnd;
    };
    for (const n of names) {
      const name = (typeof n === "string" ? n : (n && n.name) || "").trim();
      if (!name) continue;
      // 判断该 skill 是否在本 step 时间窗口内被调用。识别三种证据：
      // 1) tool_use Skill（input.skill 匹配）
      // 2) skill_search 工具（query 含 skill 名，或 "select:skill1,skill2" 格式）
      // 3) Read 调用读 skills/<name>/SKILL.md（引擎/agent 加载 skill 的另一种方式）
      const bareName = stripPluginPrefix(name);
      const inStepCalls = (trace.tool_calls || []).filter(e => inStepWindow(e));
      const calledViaSkillTool = inStepCalls.some(e =>
        e.tool_name === "Skill" &&
        stripPluginPrefix(String((e.tool_input || {}).skill || "")) === bareName
      );
      const calledViaSkillSearch = inStepCalls.some(e => {
        if (e.tool_name !== "skill_search") return false;
        const q = String((e.tool_input || {}).query || "");
        const parts = q.startsWith("select:") ? q.slice("select:".length).split(",") : [q];
        return parts.map(stripPluginPrefix).includes(bareName);
      });
      const calledViaReadSkillMd = inStepCalls.some(e => {
        if (e.tool_name !== "Read") return false;
        const path = String((e.tool_input || {}).file_path || (e.tool_input || {}).path || "");
        const m = /skills[\\/]+([^\\/]+)[\\/]+SKILL\.md/i.exec(path);
        return m ? stripPluginPrefix(m[1]) === bareName : false;
      });
      const calledInStep = calledViaSkillTool || calledViaSkillSearch || calledViaReadSkillMd;
      // 本 step 内已调用 → 跳过；未调用 → 分析（不区分主辅）
      if (calledInStep) continue;
      const skillCalls = _relatedCalls(trace, (tn, inp) => tn === "Skill" && String(inp.skill || "") === name);
      const failureLogs = _relatedFailures(trace, (tn, inp) => tn === "Skill" && String(inp.skill || "") === name);
      // 读取 skill 摘要，供 LLM 生成"如何在 prompt 中引导调用"的建议
      const skillSummary = _skillSummary(name, pluginRoot);
      // 每个 skill 一个独立 candidate；cluster 按步骤名区分，控制单次 LLM 调用规模
      candidates.push(new Candidate("S24", `C2:${step.name}`,
        `步骤「${step.name}」配置了 skill「${name}」但执行时未调用`,
        {
          count: 1,
          items: [{
            step: step.name, stepId: step.stepId, skill: name,
            hasCalls: skillCalls.length > 0,
            failureLogs,
            skillSummary,
          }],
          stepPrompts: { [step.name]: stepPrompts[step.name] },
        },
        [],
        400));
    }
  }
  return candidates;
}

// ---- S25 配置了 mcp 但未调用 ----
// 按每个未调用的 mcp 拆分为独立 candidate（同 cluster 共享 1 次 LLM 调用），
// LLM 按 candidate index 分别给出每个 mcp 未调用的具体 root_cause。
function detectS25(trace, slices, s2s, workflow) {
  const steps = workflow && Array.isArray(workflow.steps) ? workflow.steps : [];
  if (steps.length === 0) return [];
  const pluginRoot = workflow.pluginRoot || null;
  const calledMcp = new Set((trace.tool_calls || [])
    .filter(e => e.tool_name && e.tool_name.startsWith("mcp__"))
    .map(e => e.tool_name));
  const stepPrompts = {};
  const candidates = [];
  for (const step of steps) {
    const mcps = step.configuredMcps || [];
    if (mcps.length === 0) continue;
    if (!stepPrompts[step.name]) stepPrompts[step.name] = _stepPromptSnippet(step, pluginRoot);
    for (const m of mcps) {
      const name = (typeof m === "string" ? m : (m && (m.name || m.id)) || "").trim();
      if (!name) continue;
      const prefix = `mcp__${name}`;
      const mcpUsed = [...calledMcp].some(t => t.startsWith(prefix));
      if (mcpUsed) continue;
      const mcpCalls = _relatedCalls(trace, (tn) => tn.startsWith(prefix));
      const failureLogs = _relatedFailures(trace, (tn) => tn.startsWith(prefix));
      candidates.push(new Candidate("S25", `C3:${step.name}`,
        `步骤「${step.name}」配置了 MCP server「${name}」但执行时未调用`,
        {
          count: 1,
          items: [{
            step: step.name, stepId: step.stepId, mcp: name,
            hasCalls: mcpCalls.length > 0,
            failureLogs,
          }],
          stepPrompts: { [step.name]: stepPrompts[step.name] },
        },
        [],
        300));
    }
  }
  return candidates;
}

// ---- S26 配置了知识库但过程中未读取 ----
// 按每个未检索的知识库拆分为独立 candidate（同 cluster 共享 1 次 LLM 调用），
// LLM 按 candidate index 分别给出每个知识库未检索的具体 root_cause。
function detectS26(trace, slices, s2s, workflow) {
  const steps = workflow && Array.isArray(workflow.steps) ? workflow.steps : [];
  if (steps.length === 0) return [];
  const allCalls = trace.tool_calls || [];
  const usedSkills = trace.skills_used || [];
  const pluginRoot = workflow.pluginRoot || null;
  // 知识库检索 = openviking 检索/读取类工具（list/read/search/tree/documents），
  // 排除 get_kb_permissions 权限查询（不算"读取知识库"）
  const kbReadMatch = (tn) => tn && /openviking/i.test(tn) && !/get_kb_permissions|permissions?/i.test(tn);
  const hasKbRead = allCalls.some(e => kbReadMatch(e.tool_name)) || usedSkills.some(s => /aceharness[-_]?rag|openviking/i.test(s));
  if (hasKbRead) return [];
  const stepPrompts = {};
  const candidates = [];
  for (const step of steps) {
    const kbs = step.configuredKbs || [];
    if (kbs.length === 0) continue;
    if (!stepPrompts[step.name]) stepPrompts[step.name] = _stepPromptSnippet(step, pluginRoot);
    for (const kb of kbs) {
      const kbName = (typeof kb === "string" ? kb : (kb && (kb.name || kb.id)) || "").trim();
      if (!kbName) continue;
      const kbCalls = _relatedCalls(trace, (tn) => kbReadMatch(tn));
      const failureLogs = _relatedFailures(trace, (tn) => /openviking/i.test(tn || ""));
      candidates.push(new Candidate("S26", `C1:${step.name}`,
        `步骤「${step.name}」配置了知识库「${kbName}」但整个会话未进行任何知识库检索（openviking/aceharness-rag）`,
        {
          count: 1,
          items: [{
            step: step.name, stepId: step.stepId, kb: kbName,
            hasCalls: kbCalls.length > 0,
            failureLogs,
          }],
          stepPrompts: { [step.name]: stepPrompts[step.name] },
        },
        [],
        350));
    }
  }
  return candidates;
}

// ---- 注册表 ----
const ALL_DETECTORS = [
  detectS1, detectS2, detectS3, detectS4, detectS5, detectS6,
  detectS7, detectS8, detectS9, detectS10, detectS11, detectS12,
  detectS13, detectS14, detectS15, detectS16, detectS17, detectS18,
  detectS19, detectS20, detectS21, detectS22, detectS23,
  detectS24, detectS25, detectS26,
];

export function runAll(trace, slices, workflow = null) {
  const s2s = _seqToSlice(slices);
  const out = [];
  for (const det of ALL_DETECTORS) {
    try {
      out.push(...det(trace, slices, s2s, workflow));
    } catch (ex) {
      console.error(`[detector ${det.name} error] ${ex.message}`);
    }
  }
  return out;
}
