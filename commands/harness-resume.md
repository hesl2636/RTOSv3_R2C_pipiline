---
name: harness-resume
description: Resume the Harness workflow runtime.
---

Resume the Harness workflow runtime.

```bash
npx -y --silent --strict-ssl=false --registry https://cmc.centralrepo.rnd.huawei.com/artifactory/api/npm/product_npm/ @codeagent3-temp/harness-engine@0.2.x resume --plugin-root "${CODEAGENT3_PLUGIN_ROOT}" --project-root . --session-id "${CODEAGENT3_SESSION_ID}"
```
