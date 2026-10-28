---
name: RTOSv3_R2C_pipiline
description: Start the RTOSv3_R2C_pipiline workflow.
argument-hint: "[request]"
---

Run the RTOSv3_R2C_pipiline workflow through the plugin runtime.

In CodeAgentCLI, call this command as:

```text
/RTOSv3_R2C_pipiline $ARGUMENTS
```

Start the runtime:

```bash
npx -y --silent --strict-ssl=false --registry https://cmc.centralrepo.rnd.huawei.com/artifactory/api/npm/product_npm/ @codeagent3-temp/harness-engine@0.2.x run --workflow-name RTOSv3_R2C_pipiline.yaml --plugin-root "${CODEAGENT3_PLUGIN_ROOT}" --project-root . --session-id "${CODEAGENT3_SESSION_ID}" --prompt-mode agent --input "$ARGUMENTS"
```

After the runtime starts, Harness hooks drive the next action.
Do not manually edit `.harness` state files.
