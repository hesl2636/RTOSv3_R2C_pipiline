import { spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const tmpDir = mkdtempSync(join(tmpdir(), 'sdoc-prompt-'));
const promptFile = join(tmpDir, 'prompt.txt');
writeFileSync(promptFile, 'Reply with exactly: ok', 'utf-8');
const safePath = promptFile.split('\\').join('/');

const script = `codeagent -p "$(cat '${safePath}')" --output-format json --model maas-glm-5.2-volcengine-codeagent --skip-safe-check`;
console.log('script:', script.slice(0, 120));
const start = Date.now();
const result = spawnSync('bash', ['-c', script], {
  encoding: 'utf-8',
  timeout: 300000,
  maxBuffer: 50 * 1024 * 1024,
});
console.log('elapsed:', Date.now() - start, 'ms');
console.log('status:', result.status);
console.log('signal:', result.signal);
console.log('error:', result.error?.code);
console.log('stdout (first 500):', (result.stdout || '').slice(0, 500));
console.log('stderr (first 300):', (result.stderr || '').slice(0, 300));
try { unlinkSync(promptFile); } catch {}
