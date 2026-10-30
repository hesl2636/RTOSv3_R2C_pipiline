# Compatibility matrix

Generated from `package.json` and `adapters/*/adapter.json` by
`node scripts/release.mjs --compat`. Do not edit by hand:
`node scripts/release.mjs --check` fails when this file drifts.

| Dimension | Object | Range |
| --- | --- | --- |
| Version | `r2c-runner`, `r2c-payload-0.1.0.tgz`, adapters | `0.1.0` |
| Engine ↔ payload | `r2c-payload.json.engine` | `^0.1.0` |
| Engine ↔ adapter | `adapters/claude-code/adapter.json` | `^0.1.0` |
| Engine ↔ adapter | `adapters/codex/adapter.json` | `^0.1.0` |
| Engine ↔ adapter | `adapters/dsh/adapter.json` | `^0.1.0` |
| Engine ↔ adapter | `adapters/omp/adapter.json` | `^0.1.0` |
| Engine ↔ adapter | `adapters/opencode/adapter.json` | `^0.1.0` |
| Agent | `claude-code` (Claude Code) | `>=2.1.312 <3` |
| Agent | `codex` (Codex) | `>=0.165.0 <1` |
| Agent | `dsh` (DeepSeek Harness) | `>=0.2.1-rc.2 <0.3.0` |
| Agent | `omp` (Oh My Pi (omp)) | `>=18.13.2 <19` |
| Agent | `opencode` (opencode (V1)) | `>=1.19.5 <2` |
| Node | `r2c-runner` | `>=22.19.0 <23 \|\| >=24.0.0` |
