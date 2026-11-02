# Changelog

All notable changes to `r2c-runner` are recorded here. The version is locked
step-by-step across the engine, the payload, and all five agent adapters; see
`docs/compat.md`.

## [Unreleased]

### Added

- r2c runtime install surface: one `r2c.runtime/v1` receipt per project owns
  the versioned engine (`.r2c/engine/<V>/`), the fixed resolver launcher
  `.r2c/bin/r2c.js`, the `/r2c-*` host commands, hook carriers, pointer-level
  `settings.json`/`opencode.json`/mcp merges and the dsh runtime patch. Engine
  upgrades rewrite only `runtime.json` and the engine directory; bundle
  receipts never record an engine version.
- Install-time `render-roles`: the installer renders `claude-code`, `codex`,
  `omp` and `opencode` agent definitions from the IR through
  `runtime/shared/render-role.js` as `r2c-<id>`, records them (with field-level
  degradations) in the receipt and writes `.r2c/projection/roles.json`; dsh
  renders no roles.
- Installer `status` (works without a run) and `doctor` (receipt hashes,
  missing/extra files, engine entry/launcher/version, manifest selection, host
  detection, degradation/placeholder summary, transaction residue); engine
  `r2c status` gains `installs[]` and trailing install lines without changing
  exit codes or existing lines.
- Local web build surface: `POST /api/uploads` keeps the uploaded zip and
  compiled IR in the 0700 session directory; `POST /api/builds` re-runs the
  shared projections in-process and packages through `scripts/release.mjs` as an
  isolated child (`shell:false`, 120 s kill, no `GH_TOKEN`/`GITHUB_TOKEN`,
  JSON-lines stdout, capped and redacted stderr, crash → `WEB_CHILD_FAILED`).
  Canonical options build publishable assets; custom stage order / skill /
  target selections build locally with `publishable:false`. The page renders
  file/byte counts, the capability matrix, degradation groups, warnings, the
  file list and result digests from the projection result and copies a
  fixed-version `install.mjs` command without writing to any project.
- `scripts/release.mjs --bundle <zip|dir> --out DIR --options FILE --json`:
  the bundle packager accepts resolved options (recording the actual selection
  in each payload manifest) and emits JSON-lines progress for the web child.
- Local web publish: `POST /api/builds/:id/publish` runs
  `scripts/release.mjs --publish --out <session build dir> --json` as the only
  credentialed child (300 s kill, JSON-lines phases, capped/redacted stderr,
  crash → `WEB_CHILD_FAILED`); the token stays in server memory, so the page
  never sees it and never calls GitHub. Jobs expose
  draft → upload → verify → publish, published tags are never rewritten, and
  the session reports `publish:{enabled,reason,repo}` (no token → a disabled
  button and a 403). Publishing is limited to 10/h with concurrency 1
  (429 + `Retry-After`), rejects a client/server digest mismatch, and the
  published release's frozen install commands are shown for the installer.
- `scripts/release.mjs --publish --out <built-dir> [--tag TAG] --json`:
  publish an existing build without re-projecting or re-packing; `GH_REPO` and
  the operator-only `R2C_GITHUB_API` select the target, and every asset is
  checked against its own `SHA256SUMS.txt` before the draft is created.

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

### Fixed

- Adding a second adapter to one project now works through the documented
  path: the bootstrap accepts and forwards `--force`, so the layout already
  owned by the first adapter's receipt is backed up and replaced instead of
  failing with `CONFLICT` on a flag the bootstrap rejected.
- A renamed or moved project keeps working: install, doctor and uninstall
  resolve every receipt path (layout copies, agent config, payload and engine
  homes, merged files, created directories) against the live project root and
  fall back to the root the receipt recorded only when the file is absent
  there. Previously uninstall reported `files: []` and orphaned the install
  while a re-install saw conflicts.
- The bootstrap enforces `engines.node` before it downloads anything: an
  unsupported Node exits `2` instead of extracting an engine that cannot run
  and rolling it back.
- `PAYLOAD_CHECKSUM_MISMATCH` has one exit code (`2`) wherever the archive
  came from; the staged and downloaded paths no longer answered `3`.
- The bootstrap's engine-archive path check enforces the same 100-byte bound
  the engine does, so a hand-built archive cannot carry a longer path.
- The bootstrap can target a non-default dsh profile with `--profile <name>`,
  which is forwarded to `adapter install`.
- A renamed or moved project stays consistent after a later install that
  writes anything: skipped receipt entries are recorded against the live root,
  so `doctor` no longer reports them missing and `uninstall` no longer leaks
  them.
- Upgrading or rolling back removes layout files the previous payload carried
  but the new one does not ship, after backing each one up. A hand-edited
  stale file is kept and reported as `layout-stale:` instead of being deleted.
- Atomic writes retry transient Windows `EPERM`/`EACCES`/`EBUSY` renames: a
  concurrent reader could make the `latest.json` replacement fail after the
  claim event and `state.json` were written, so `hook stop` exited 1 and the
  run kept a claim event with a stale route.

### Changed

- The release transport and GitHub credential chain moved to
  `src/adapter/release.js`; `payload.js` keeps resolution, verification and
  materialisation, and tests import the release helpers from their new module.
  The payload and engine collectors and path rules are now one parameterised
  implementation in `plugin.js`.
