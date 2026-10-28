---
name: harness-cancel
description: Cancel the Harness workflow runtime.
---

Cancel the Harness workflow runtime.

```bash
npx -y --silent --strict-ssl=false --registry LEGACY_NPM_REGISTRY_URL @codeagent3-temp/harness-engine@0.2.x cancel --legacy-plugin-root "${LEGACY_PLUGIN_ROOT}" --project-root . --session-id "${LEGACY_SESSION_ID}"
```
