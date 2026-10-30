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
- One release path: a tag builds exactly four assets (`r2c-engine-0.1.0.tgz`,
  `r2c-payload-0.1.0.tgz`, `install.mjs`, `SHA256SUMS.txt`) from one
  reproducible build. `release.mjs --check` is the pre-publish gate (asset
  whitelist, locked engine ranges, payload manifest coverage, `docs/compat.md`,
  CHANGELOG section, lockfile), and npm publishing is gone along with its
  token and provenance permissions.
- Engine release asset `r2c-engine-0.1.0.tgz` (CLI entry, sources, schema,
  `package.json`, the vendored `yaml` dependency and LICENSE) plus the
  self-contained `scripts/install.mjs` bootstrap that downloads the engine,
  verifies it against `SHA256SUMS.txt`, extracts it to `.r2c/engine/<V>/`
  (or `~/.r2c/engine/<V>/`) and runs the engine's `adapter install`. A tampered
  or missing release asset fails the bootstrap with nothing written: the
  checksum stage never extracts, and a failed hand-off removes the engine that
  run extracted.
- Bootstrap credential chain for a private release — `GH_TOKEN` →
  `GITHUB_TOKEN` → `git credential fill` for `host=github.com`, non-interactive
  and time-limited — so a machine without `gh` still installs; when no
  credential exists the anonymous `404` is reported as "a token is required"
  with the `gh auth login` hint instead of a generic failure.
- Engine, payload and adapters move as one version set: installing another
  version retires the previous engine and payload that the receipt owned unless
  another receipt still references them, `adapter uninstall` and `adapter prune`
  remove unreferenced engines, and `--dry-run` lists the removals.
- Adapters for `claude-code`, `codex`, `dsh`, `omp`, and `opencode`, each with
  install, doctor, smoke, and uninstall steps plus a shared command/skill source.
- Every install copies the payload layout (`workflows/`, `tasks/`, `skills/`)
  into the project root and records each file's project-relative path and
  sha256 in the receipt, so `r2c run` works with no manual copy; `doctor`
  reports hand-edited copies and uninstall reverts them.
- Hook shims for stop, claim, and pre-tool-use events in each agent's native
  stdin/stdout dialect.
- CI gates for tests, manifest validation, the release asset contract, and the
  acceptance matrix, plus manual live probes and a tag-gated release workflow.
