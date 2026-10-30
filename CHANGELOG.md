# Changelog

All notable changes to `r2c-runner` are recorded here. The version is locked
step-by-step across the engine, the payload, and all five agent adapters; see
`docs/compat.md`.

## [0.1.0] - 2026-10-28

### Added

- Declarative workflow runner (`r2c run|next|submit|status|pause|resume|cancel|token-usage|validate`)
  with strict manifest validation, run state, events, claims, and usage accounting.
- Payload builder (`node scripts/release.mjs`) producing the deterministic
  `r2c-payload-0.1.0.tgz` archive, its `r2c-payload.json` manifest, and
  `SHA256SUMS.txt`.
- Adapters for `claude-code`, `codex`, `dsh`, `omp`, and `opencode`, each with
  install, doctor, smoke, and uninstall steps plus a shared command/skill source.
- Hook shims for stop, claim, and pre-tool-use events in each agent's native
  stdin/stdout dialect.
- CI gates for tests, manifest validation, release contract checks, the npm pack
  whitelist, and the acceptance matrix, plus manual live probes and a tag-gated
  release workflow.
