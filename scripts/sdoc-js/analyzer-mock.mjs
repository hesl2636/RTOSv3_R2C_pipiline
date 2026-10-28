// analyzer-mock.mjs — 合并分析器的 mock 实现（规则判定 + 规则知识块）
// 与 Analyzer（codeagent）同构：analyze(candidates, wiki, trace, facts, retriever) → [verdicts, blocks, stats]
// 复用 MockConfirmer（规则判定）+ MockFixer（规则知识块 + 成功命令提取）

import { MockConfirmer } from './confirmer.mjs';
import { MockFixer } from './fixer.mjs';

export class MockAnalyzer {
  constructor() { this.name = "mock"; }

  analyze(candidates, wiki, trace, facts, retriever = null) {
    const confirmer = new MockConfirmer();
    const fixer = new MockFixer();

    const [verdicts, confirmStats] = confirmer.confirm(candidates, wiki, trace);
    const [blocks, patch, fixStats] = fixer.fix(verdicts, wiki, trace, facts, retriever);

    return [
      verdicts,
      blocks,
      {
        backend: "mock",
        calls: 0,
        cost_usd: 0.0,
        input_tokens: 0,
        output_tokens: 0,
        multi_round_calls: 0,
        confirm: confirmStats,
        fix: fixStats,
      },
    ];
  }
}
