# Legacy yellow-zone tree

The last usable intranet (CodeAgentCLI) snapshot is tagged, archived and
documented here so that yellow-zone users keep an addressable reference after
the blue-zone migration. History was not rewritten and no `legacy/` directory
exists in the working tree.

## Archive identity

| Item | Value |
| --- | --- |
| Tag | `legacy-yellow-zone` (annotated) |
| Tagged commit | `0a0182048e7885410c57a4d3ac062994d791b5b0` (`main` tip at migration time) |
| Archive command | `git archive --format=zip --prefix=RTOSv3_R2C_pipiline-legacy/ legacy-yellow-zone -o .scratch/legacy-yellow-zone.zip` |
| Archive file | `.scratch/legacy-yellow-zone.zip` (local, git-ignored, not committed) |
| Archive bytes | 140231 |
| Archive sha256 | `3dc4b154642df7906cc81b232d76190e041ae3999a0b1ff2c89281d2cbb4b3b9` |

Re-create and re-verify:

```bash
git archive --format=zip --prefix=RTOSv3_R2C_pipiline-legacy/ \
  legacy-yellow-zone -o .scratch/legacy-yellow-zone.zip
sha256sum .scratch/legacy-yellow-zone.zip
# 3dc4b154642df7906cc81b232d76190e041ae3999a0b1ff2c89281d2cbb4b3b9
```

The hash is stable for a given tag because `git archive` output depends only on
the tagged tree, the entry mtimes git records and the archive options above.
Re-running the command must reproduce the recorded value; if it does not, the
tag moved — treat that as a defect.

## Disposition list

### Removed (intranet entry points)

| Path | Why it is gone |
| --- | --- |
| `bin/cli.js` | Forwarded every command to the intranet npm registry with a plugin-root argument and `--ssl-flag`. Replaced by `bin/r2c.js`, a thin entry to `src/cli.js`. |
| `plugin.json` | Root CodeAgentCLI plugin manifest; no consumer outside the intranet harness. |
| `.claude-plugin/plugin.json` | Byte-identical duplicate of the root manifest; pointed at `commands/` and `skills/`, which moved to `pack/`. |
| `hooks/hooks.json` | Legacy `Stop`/`PreToolUse` wiring built from intranet environment variables and the registry address. Rebuilt per agent under `adapters/*/`. |
| `hooks/harness-guard.js` | Guard that located runs by walking the retired per-user state directory. The engine now resolves state from the project's `.r2c/`. |

Empty `hooks/`, `scripts/`, `.claude-plugin/`, `workflows/`, `tasks/`,
`skills/` and `commands/` directories are removed; nothing is left as a stub.

### Moved (content preserved)

| Legacy path | New path |
| --- | --- |
| `workflows/RTOSv3_R2C_pipiline.yaml` | `pack/workflows/hm2B_drvport_pipiline.yaml` |
| `tasks/step-*.md` (4 files) | `pack/tasks/step-*.md` |
| `skills/<id>/SKILL.md` (35 skills) | `pack/skills/<id>/SKILL.md` |
| `commands/*.md` (7 files) | `pack/commands/*.md` |
| `scripts/upload-session.mjs` | `plugins/upload/upload-session.mjs` |
| `scripts/lib/*.mjs` | `plugins/upload/lib/*.mjs` |
| `scripts/analyze-session.mjs` | `plugins/analysis/analyze-session.mjs` |
| `scripts/sdoc-js/**` | `plugins/analysis/sdoc-js/**` |
| `codeagent-extension.json` | `plugins/intranet-mcp/servers.json` |
| `config.json` | `plugins/upload/config.example.json` (secrets/hosts removed, keys kept with placeholder values) |
| `docs/agents/issue-tracker.md` | unchanged |

### Changed at the root

- `package.json` is now the publishable `r2c-runner@0.1.0` (`type: module`,
  `bin.r2c`, `engines.node`, `yaml` dependency, `files` whitelist, no
  `private`, no `postinstall`/`prepare`). The legacy `yazl` dependency is
  gone; `package-lock.json` was regenerated.
- `.gitignore` now lists only the five `.r2c` runtime paths plus
  `node_modules/`; local-only patterns moved to `.git/info/exclude`.
- Content moved into `pack/` and `plugins/` is byte-identical to the tagged
  tree **except** for intranet coordinates: the registry address,
  `CODEAGENT3`-prefixed environment variables, the plugin-root flag and the retired per-user
  state directory were replaced with placeholders (`LEGACY_NPM_REGISTRY_URL`,
  `LEGACY_*`, `--legacy-plugin-root`, `.legacy-state`) and intranet hostnames
  with `*.example.invalid`. Those exact bytes remain recoverable from the tag.
  See `docs/plugins.md`.

## Rollback

The archive is read-only recovery; do not branch from it for development.

1. Inspect a single file without checking anything out:

   ```bash
   git show legacy-yellow-zone:bin/cli.js
   ```

2. Materialize the whole tree in a detached worktree:

   ```bash
   git worktree add --detach ../RTOSv3_R2C_pipiline-legacy legacy-yellow-zone
   # ...
   git worktree remove ../RTOSv3_R2C_pipiline-legacy
   ```

   Or unzip the archive (its entries are prefixed with
   `RTOSv3_R2C_pipiline-legacy/`):

   ```bash
   unzip .scratch/legacy-yellow-zone.zip -d ../legacy-restore
   ```

3. Diff the migrated files against the archive when a rewrite is suspected:

   ```bash
   git diff legacy-yellow-zone -- pack/ plugins/
   ```

4. Running the legacy tree needs the yellow zone: the intranet npm registry,
   CodeAgentCLI / the `codeagent` binary and the retired per-user state
   directory. It is not runnable from the blue zone, and `docs/plugins.md`
   explains why the intranet plugins are frozen rather than installed.

A rollback is not "point `PATH` at the old engine": the engine, the payload and
the adapters are version-locked. Restoring the intranet workflow means checking
out the tag in the yellow zone, not downgrading the blue-zone runner in place.
