@echo off
setlocal
"${NODE_BIN}" "${PAYLOAD_HOME}/shims/hook.mjs" --agent codex --event pre-tool-use --format json --project-root "${PROJECT_ROOT}" --runner-cmd "${RUNNER_CMD}"
exit /b %ERRORLEVEL%
