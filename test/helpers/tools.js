/**
 * Tool sentinels: stand-in `npm`, `npx`, `gh` and `git` binaries that record
 * their invocation and refuse to run. A test that prepends this directory to
 * PATH and then sees an empty marker has proof the chain never reached for a
 * package manager, the GitHub CLI or a credential helper — which is stronger
 * than asserting the tools are absent, because CI images often ship npm next
 * to node.
 */
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_TOOLS = Object.freeze(['npm', 'npx', 'gh', 'git']);

export function toolSentinels(t, tools = DEFAULT_TOOLS) {
  const dir = mkdtempSync(join(tmpdir(), 'hm2b-path-shims-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const marker = join(dir, 'invoked.log');
  for (const name of tools) {
    if (process.platform === 'win32') {
      writeFileSync(join(dir, `${name}.cmd`), `@echo off\r\necho ${name} %*>>"${marker}"\r\nexit /b 91\r\n`);
    } else {
      const file = join(dir, name);
      writeFileSync(file, `#!/bin/sh\nprintf '%s %s\\n' "${name}" "$*" >> "${marker}"\nexit 91\n`);
      chmodSync(file, 0o755);
    }
  }
  return {
    dir,
    marker,
    /** True when the chain reached for any sentinel tool. */
    invoked() {
      return existsSync(marker);
    },
  };
}
