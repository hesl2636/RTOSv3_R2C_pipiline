#!/usr/bin/env node
/**
 * bin/cli.js — 插件 CLI 入口
 *
 * 引擎 hook-stop 生成的 agent 面向命令（submit, status, resume, cancel,
 * submit-gate-review, token-usage）通过此入口调用。
 * 此文件将命令转发到 harness-engine (via npx)。
 *
 * Hook 命令（hook stop, hook pre-tool-use）不通过此入口 —
 * 它们由 hooks.json 直接通过 npx 调用引擎。
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 从 argv 解析 --plugin-root，其余参数转发给引擎
const argv = process.argv.slice(2);
let pluginRoot = '';
const forwarded = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--plugin-root') {
    pluginRoot = argv[++i];
  } else {
    forwarded.push(argv[i]);
  }
}

// 如果没有 --plugin-root，从脚本位置推导（bin/cli.js → 上级目录）
if (!pluginRoot) {
  pluginRoot = path.resolve(__dirname, '..');
}

// 转发到 harness-engine via npx
const result = spawnSync('npx', [
  '-y', '--silent', '--strict-ssl=false', '--registry', 'https://cmc.centralrepo.rnd.huawei.com/artifactory/api/npm/product_npm/', '@codeagent3-temp/harness-engine@0.2.x',
  ...forwarded,
  '--plugin-root', pluginRoot,
], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

process.exit(result.status ?? 0);
