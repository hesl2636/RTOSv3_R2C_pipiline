# Changelog

All notable changes to `hm2b-runner` are recorded here. The version is locked
step-by-step across the engine, the payload, and all five agent adapters; see
`docs/compat.md`.

## [Unreleased]

### Changed

- Rename: the project is `hm2b`, the framework package is `hm2b-framework`, the
  engine package is `hm2b-runner`, and the runtime projection is `runner`. The
  runtime receipt is `hm2b.runtime/v1`, the payload manifest is
  `hm2b.release-payload/v1`, and `HM2B_GITHUB_API` replaces the old API
  override.
- Terminology: the compiled bundle artifact is the **compiled workflow**
  (`hm2b.compiled-workflow/v2`, `workflow.compiled.json`). The old `IR` name,
  module, constants, CLI command, API fields and UI labels are retired because
  Huawei uses IR for *initial requirement*; `hm2b.ir/v2` documents are now
  rejected. The R2C bundle's own IR/SR/AR references remain domain content and
  are unchanged.
- P6 cutover (#111): the engine moved to `runtime/runner/engine/`, the pure
  manifest contract to `runtime/runner/contract/`, and the runtime assets to the
  two runtimes. The legacy directory trees, the declaration-driven install
  mechanism, the four role templates, the old acceptance command and the
  top-level schema/shims/pack/plugin trees are retired with wired
  replacements. Architecture tests enforce the static import graph, the
  engine's dependency cut and the released source sets. Glossary and docs
  describe only the bundle/projection/target vocabulary.

### Added

- Contract v2 assets: `hm2b.bundle/v2` and `hm2b.compiled-workflow/v2` carry the optional
  `knowledgeBase`, `checklists`, `hooks` and `mcp` declarations with their
  directories `knowledge-base/`, `checklists/`, `hooks/hooks.json` and
  `mcp.json` (at most 4 path segments each). `compile` embeds every declared
  body and source hash in the compiled workflow; the `runner` projection installs the assets
  at the project root and `agent-native` installs them once under
  `.agents/agent-native/<bundle-id>/`.
- Install from a per-bundle Release (#106): `install.mjs` keeps its name and
  legacy flags and gains `--bundle <id>`, `--version`, `--projection
  runner|agent-native`, repeatable `--target` and `--project`. The bootstrap
  downloads the Release, verifies assets against `SHA256SUMS.txt`, cross-checks
  the zip / compiled workflow / payload manifest (id, version, compiled workflow digest, content digest) and
  the payload members against the manifest, then hands the verified bytes to
  the framework's installer — never compiling or projecting. Any mismatch exits
  2 before a write. `requires.projections` is a hard whitelist,
  `requires.engine` is evaluated only for runner, and `--target` narrows writes
  without re-projecting (the bundle `roles.json` is still installed). The
  runner projection installs the runtime plus the bundle; agent-native installs
  its five targets.
- `hm2b.release-payload/v1` manifest and the pre-projected payload tgz contract
  moved to `installer/release-payload.js` and `installer/release-tar.js`; the
  manifest records the validated projection result without file content, and
  every file entry records its `origin` (and `assetId` when projected from an
  asset) so an installer can rebuild the exact V1–V12-validated result.
- Runner runtime install surface: one `hm2b.runtime/v1` receipt per project owns
  the versioned engine (`.hm2b/engine/<V>/`), the fixed resolver launcher
  `.hm2b/bin/hm2b.js`, the `/hm2b-*` host commands, hook carriers, pointer-level
  `settings.json`/`opencode.json`/mcp merges and the dsh runtime patch. Engine
  upgrades rewrite only `runtime.json` and the engine directory; bundle
  receipts never record an engine version.
- Install-time `render-roles`: the installer renders `claude-code`, `codex`,
  `omp` and `opencode` agent definitions from the compiled workflow through
  `runtime/shared/render-role.js` as `runner-<id>`, records them (with field-level
  degradations) in the receipt and writes `.hm2b/projection/roles.json`; dsh
  renders no roles.
- Installer `status` (works without a run) and `doctor` (receipt hashes,
  missing/extra files, engine entry/launcher/version, manifest selection, host
  detection, degradation/placeholder summary, transaction residue); engine
  `hm2b status` gains `installs[]` and trailing install lines without changing
  exit codes or existing lines.
- Local web build surface: `POST /api/uploads` keeps the uploaded zip and
  compiled workflow in the 0700 session directory; `POST /api/builds` re-runs the
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
  the operator-only `HM2B_GITHUB_API` select the target, and every asset is
  checked against its own `SHA256SUMS.txt` before the draft is created.

### Fixed

- Review pass on the spec-83 integration: the Release install is one
  all-or-rollback transaction (legacy/occupancy/V1–V12 preflight before any
  runtime write, and a bundle failure restores the runtime snapshot); the runner
  singleton is re-checked under the install lock; `--publish --out` re-opens
  the built zip and refuses a zip/compiled workflow/tag mismatch or a non-canonical payload
  (`WEB_PUBLISH_NOT_CANONICAL`) before the first remote call.
- Correctness: V8 now rejects over-degradation not explained by an exclusive
  skill option; `BUNDLE_STEP_NO_SKILLS` respects S8 and never doubles a
  `BUNDLE_SCHEMA_INVALID`; distinct frontmatter/tool violations keep distinct
  pointers; `options.extra` is echoed verbatim; runner host roles render only the
  selected skills and record the #82 preload loss at the seam.
- Shared contracts: one module for result field order, capability vocabulary
  and level ranks, and one `requires.engine` evaluator (projection, web,
  installer); receipts also carry top-level `compiled_workflow_path`; the agent-native
  manifest declares its static target assets (id/path/sha256).
- Web hardening: missing `Sec-Fetch-Site` is refused and an oversized header
  returns 413; the engine version (not the framework version) feeds web build
  and `requires.engine`; `serve.mjs` is split into HTTP/build/publish modules
  without response changes.
- Removed duplicated helpers (`sorted`, JSON equality, sha256, atomic write),
  the `scripts/lib/release-tar.mjs` alias, and unused shared-import members;
  compile `--json` reports the report at `data`; the installer CLI accepts
  repeatable `--target`.

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
