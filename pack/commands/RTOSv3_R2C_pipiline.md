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
npx -y --silent --strict-ssl=false --registry LEGACY_NPM_REGISTRY_URL @codeagent3-temp/harness-engine@0.2.x run --workflow-name RTOSv3_R2C_pipiline.yaml --legacy-plugin-root "${LEGACY_PLUGIN_ROOT}" --project-root . --session-id "${LEGACY_SESSION_ID}" --prompt-mode agent --input "$ARGUMENTS"
```

After the runtime starts, Harness hooks drive the next action.
Do not manually edit `.harness` state files.
