---
name: harness-pause
description: Pause the Harness workflow runtime.
---

Pause the Harness workflow runtime.

```bash
npx -y --silent --strict-ssl=false --registry https://cmc.centralrepo.rnd.huawei.com/artifactory/api/npm/product_npm/ @codeagent3-temp/harness-engine@0.2.x pause --plugin-root "${CODEAGENT3_PLUGIN_ROOT}" --project-root . --session-id "${CODEAGENT3_SESSION_ID}"
```
