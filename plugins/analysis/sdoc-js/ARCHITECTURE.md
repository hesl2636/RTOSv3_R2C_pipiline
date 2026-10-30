# sdoc-js 架构设计

> Python → JavaScript 原样迁移。本文档对照 Python 版每个模块，确认覆盖关系。

## 目录结构

```
code/sdoc-js/
├── index.mjs            # 主入口 export { run, writeKnowledge }
├── model.mjs            # 数据结构：SessionEvent / SessionTrace / SessionSlice / Candidate / Verdict / KnowledgeBlock
├── adapter.mjs          # loadTrace(jsonlPath) → SessionTrace
├── slicer.mjs           # sliceSession(trace) → SessionSlice[]
├── detectors.mjs        # runAll(trace, slices) → Candidate[]  （18 个检测器 S1-S18）
├── metrics.mjs          # compute(trace, candidates) → metrics dict
├── wiki.mjs             # SessionWiki 倒排索引
├── codeagent-client.mjs # callModel(prompt, model) → ModelResult（async）
├── confirmer.mjs        # getConfirmer(backend, model) → { confirm(candidates, wiki, trace) }（async）
├── fixer.mjs            # getFixer(backend, model) → { fix(verdicts, wiki, trace, facts) }（async）+ extractFacts(trace, slices)
├── pipeline.mjs         # run(jsonlPath, options) → report（async）
└── tests/
    ├── fixtures/         # 复用 Python 版的 .jsonl 测试文件
    └── test-e2e.mjs      # 端到端测试
```

## 模块对照表（Python → JS）

| Python 文件 | JS 文件 | 行数(Python) | 关键改动 |
|------------|---------|-------------|---------|
| `model.py` | `model.mjs` | 139 | dataclass → class；`@property command` → getter |
| `adapter.py` | `adapter.mjs` | 170 | `re` → `RegExp`；`open(errors="replace")` → `readFileSync('utf-8')` |
| `slicer.py` | `slicer.mjs` | 123 | `max(set, key=cts.count)` → 手动众数计算 |
| `detectors.py` | `detectors.mjs` | 541 | `re.compile` → `RegExp`；`defaultdict(list)` → 对象+if；`Counter` → 手动计数 |
| `metrics.py` | `metrics.mjs` | 67 | 纯数值，直译 |
| `wiki.py` | `wiki.mjs` | 55 | `defaultdict(set)` → Map+Set；集合交集 → filter |
| `codeagent_client.py` | `codeagent-client.mjs` | 78 | `subprocess.run` → `execFileSync`(同步) |
| `confirmer.py` | `confirmer.mjs` | 121 | 保持同步（execFileSync） |
| `fixer.py` | `fixer.mjs` | 199 | 保持同步 |
| `pipeline.py` | `pipeline.mjs` | 141 | 保持同步；`_inject_knowledge` 去重 |
| `cli.py` | `index.mjs` | 169 | 去掉 argparse CLI；改为 `export { run, writeKnowledge }` |

## 18 个检测器覆盖确认

| 场景 | Python 函数 | JS 函数 | 检测机制 |
|------|-----------|---------|---------|
| S1 运行时探索 | detect_S1 | detectS1 | PROBE_RE 命令计数 ≥3 |
| S2 结构探索 | detect_S2 | detectS2 | 前20%切片全是探索 ≥5 |
| S3 命令试错 | detect_S3 | detectS3 | 同意图≥2种命令且有失败 |
| S4 git失败 | detect_S4 | detectS4 | git exit≠0 ≥2次 |
| S5 构建同错 | detect_S5 | detectS5 | error签名归一化后重复≥2 |
| S6 lint循环 | detect_S6 | detectS6 | lint→edit→lint 序列≥2 |
| S7 测试反复失败 | detect_S7 | detectS7 | 同test命令失败≥2次 |
| S8 命令不存在 | detect_S8 | detectS8 | 关键词+exit 127/126 |
| S9 依赖/权限/网络 | detect_S9 | detectS9 | 关键词族匹配 |
| S10 import找不到 | detect_S10 | detectS10 | 关键词+Read not found |
| S11 重复读文件 | detect_S11 | detectS11 | 同path Read≥3次 |
| S12 空搜索连环 | detect_S12 | detectS12 | 连续空搜索≥2次 |
| S13 Edit失败重试 | detect_S13 | detectS13 | Edit is_error + 重试 |
| S14 工具误用 | detect_S14 | detectS14 | bash主命令 cat/grep等 |
| S15 无验证声称完成 | detect_S15 | detectS15 | 有产出+零验证 |
| S16 环境变量探测 | detect_S16 | detectS16 | ENV_PROBE_RE ≥2次 |
| S17 缺失资源重试 | detect_S17 | detectS17 | 同资源名错误≥2次 |
| S18 未使用skill | detect_S18 | detectS18 | skill_listing有但零调用 |

## 关键设计决策

### 1. 同步 vs 异步

Python 版用 `subprocess.run`（同步阻塞）。JS 版用 `execFileSync`（同步阻塞），保持调用链同步，避免 async 传染。理由：
- confirmer 按 cluster 串行调用模型，无需并发
- 同步代码与 Python 版行为完全一致，便于回归验证
- analyze-session.mjs 本身是 detached 进程，阻塞不影响 workflow

### 2. execFileSync 选择

```javascript
import { execFileSync } from 'node:child_process';

const stdout = execFileSync('codeagent', ['-p', prompt, ...], {
  encoding: 'utf-8',
  timeout: timeout * 1000,
  maxBuffer: 10 * 1024 * 1024,  // 10MB
});
```

与 Python `subprocess.run(..., capture_output=True, text=True, timeout=timeout)` 等价。

### 3. dataclass → class

```javascript
class SessionEvent {
  constructor({ seq, ts, type, role = "", tool_name = null, ... }) {
    this.seq = seq; this.ts = ts; this.type = type; ...
  }
  get command() { return this.tool_input?.command || ""; }
  toDict() { return { seq: this.seq, ... }; }
}
```

### 4. defaultdict(list) 模式

```javascript
// Python: hits = defaultdict(list); for e in events: hits[k].append(e)
const hits = {};
for (const e of events) {
  const k = keyOf(e);
  if (!hits[k]) hits[k] = [];
  hits[k].push(e);
}
```

### 5. 集合操作

```javascript
// Python: inter = ids & hit
const inter = new Set([...ids].filter(x => hit.has(x)));
// Python: unused = sorted(available - used)
const unused = [...available].filter(x => !used.has(x)).sort();
```
