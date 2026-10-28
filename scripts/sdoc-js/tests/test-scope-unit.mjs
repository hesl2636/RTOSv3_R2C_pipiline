// tests/test-scope-unit.mjs — 离线单元测试：KnowledgeBlock scope/confidence + scope 规则预判
// 纯内存测试，不依赖 codeagent CLI / 模型 / 网络

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { KnowledgeBlock } from '../model.mjs';
import { inferScope } from '../scope-rules.mjs';

describe('KnowledgeBlock scope/confidence 扩展', () => {
  test('默认 scope=personal, confidence=0', () => {
    const b = new KnowledgeBlock('T', '## T\nx');
    assert.equal(b.scope, 'personal');
    assert.equal(b.confidence, 0);
  });

  test('显式 scope 与 confidence 生效', () => {
    const b = new KnowledgeBlock('T', '## T\nx', ['S3'], 'model+facts', 'organization', 0.9);
    assert.equal(b.scope, 'organization');
    assert.equal(b.confidence, 0.9);
  });

  test('toDict 包含 scope 与 confidence', () => {
    const b = new KnowledgeBlock('T', '## T\nx', ['S1'], 'script', 'personal', 0.7);
    const d = b.toDict();
    assert.equal(d.scope, 'personal');
    assert.equal(d.confidence, 0.7);
    assert.equal(d.solves[0], 'S1');
  });

  test('JSON 序列化往返保持 scope', () => {
    const b = new KnowledgeBlock('T', '## T', ['S3'], 'm', 'organization', 0.85);
    const round = JSON.parse(JSON.stringify(b));
    assert.equal(round.scope, 'organization');
    assert.equal(round.confidence, 0.85);
  });
});

describe('inferScope 规则预判表', () => {
  test('S1 用户目录路径 → personal', () => {
    const facts = { runtimes: { 'C:\\Users\\alice\\node.exe --version': 'v20.0.0' }, commands_seen: ['C:\\Users\\alice\\node.exe --version'] };
    assert.equal(inferScope('S1', facts), 'personal');
  });

  test('S3 构建命令 → organization', () => {
    assert.equal(inferScope('S3', {}), 'organization');
  });

  test('S4 git 规范 → organization', () => {
    assert.equal(inferScope('S4', {}), 'organization');
  });

  test('S8 命令未找到 → personal', () => {
    assert.equal(inferScope('S8', {}), 'personal');
  });

  test('S9 依赖/权限 → personal', () => {
    assert.equal(inferScope('S9', {}), 'personal');
  });

  test('S17 缺失资源 → personal', () => {
    assert.equal(inferScope('S17', {}), 'personal');
  });

  test('S18 skill 配置 → personal', () => {
    assert.equal(inferScope('S18', {}), 'personal');
  });

  test('S2 结构探索 → organization（默认）', () => {
    assert.equal(inferScope('S2', {}), 'organization');
  });

  test('未知场景 → organization（默认）', () => {
    assert.equal(inferScope('S99', {}), 'organization');
  });

  test('S1 无用户目录路径 → organization（默认兜底）', () => {
    const facts = { commands_seen: ['node --version'] };
    assert.equal(inferScope('S1', facts), 'organization');
  });
});
