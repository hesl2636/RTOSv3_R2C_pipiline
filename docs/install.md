# Install, upgrade, rollback, uninstall

The engine is an npm package (`r2c-runner`); adapters are declarations that the
engine installer reads. There is no second package manager and no per-agent
install script to run: one installer path performs every write, records a
receipt, and can undo itself.

```bash
npx r2c-runner adapter list  --from <payload-dir|r2c-payload-0.1.0.tgz>
npx r2c-runner adapter install <agent> --from <payload-dir|r2c-payload-0.1.0.tgz> --project .
npx r2c-runner adapter doctor  <agent> --project .
npx r2c-runner adapter smoke   <agent> --project .
npx r2c-runner adapter uninstall <agent> --project .
```

`<agent>` is one of `claude-code`, `codex`, `dsh`, `omp`, `opencode`.
`adapter list` reads the same `adapter.json` data that
[docs/compat.md](compat.md) is generated from. Per-agent landing paths and
hook wiring are in `adapters/<agent>/README.md` (starting with
[claude-code](../adapters/claude-code/README.md)).

## Prerequisites

- Node `>=22.19.0 <23 || >=24.0.0`; the engine refuses to start outside it.
- npm (only to fetch the engine through `npx`).
- The agent CLI you are installing for, on `PATH`. The installer detects it
  with the probes in `adapter.json` (`detect.commands`, `detect.paths`) and
  exits `4` with `AGENT_NOT_DETECTED` when neither matches. Passing the id only
  as an option (`adapter install --agent <id>`, no positional) skips detection
  and records a warning instead.
- Write access to the target scope's directories (see the path table below).

## Payload: `--from <dir|tgz>`

The payload is the release artifact `r2c-payload-V.tgz`: `r2c-payload.json`,
`workflows/`, `tasks/`, `skills/`, `commands/`, `shims/hook.mjs`,
`adapters/*`, `schema/*` and `LICENSE`. The installer resolves it in this
order:

1. `--from <dir|tgz>` (a directory containing `r2c-payload.json`, or a source
   checkout with `package.json` + `pack/` + `adapters/`);
2. `R2C_PLUGIN_SOURCE` (same shapes);
3. `~/.r2c/cache/payload-<V>`;
4. the GitHub Release download for version `V`.

Anonymous downloads use the public release URL. A private repository answers the
anonymous request with `404`, so the installer walks one credential chain:
`GH_TOKEN` → `GITHUB_TOKEN` → `git credential fill` for `host=github.com`
(non-interactive, 5 s timeout; a credential stored by `gh auth login` or a git
credential helper is found here). With a token the installer reads the release
and streams its assets through the GitHub API (`/releases/tags/v<V>` +
`/releases/assets/<id>`); the web download URL itself answers `404` to token
requests. When none of the three sources yields a credential, the error names
the missing credential and `gh auth login` instead of reporting a plain `404`,
and `--from` plus the cache remain the supported path. A `.tgz` payload is
verified against the sha256 recorded in its own `r2c-payload.json`, and every
file is hashed before the plan is built. `--link` is only accepted together
with `--from <dir>`: a `.tgz` always installs with `--copy`.

The payload is materialised under `<state>/payload/<payload-version>/`, where
`<state>` is `<project>/.r2c` for project scope and `~/.r2c` for user scope.
`--plugin <V>` selects a cached payload version instead of the engine version;
`--from` takes precedence over it.

Before anything is written the installer runs: detection → payload
resolution/verification → engine and agent version gates → plan (`--dry-run`
prints it and exits) → conflict scan → pending marker → backups → atomic
writes → post-install smoke → receipt. A conflict with an unowned file fails
with exit `2`; `--force` backs the file up and replaces it. Installing the same
payload with the same options a second time performs no writes, reports
`action:"noop"`, `changed:false`, and exits `0`.

## Scopes and landing paths

Default scope is `project` for `claude-code`, `codex`, `omp` and `opencode`;
`dsh` is user-scoped. `--scope user` is accepted only where `adapter.json`
lists it. `<P>` is the project root, `~` the user home.

| Agent | Scope | Paths |
| --- | --- | --- |
| `claude-code` | project | `<P>/.claude/commands/r2c-*.md`, `<P>/.claude/skills/`, `<P>/.claude/agents/r2c-*.md`, `<P>/.claude/settings.json` (Stop + PreToolUse), `<P>/.mcp.json` with `--mcp <file>` |
| | user | `~/.claude/commands/`, `~/.claude/skills/`, `~/.claude/agents/`, `~/.claude/settings.json` (no MCP) |
| `codex` | project | `<P>/.agents/skills/r2c-*/SKILL.md` (commands are skills), `<P>/.codex/agents/r2c-*.toml`, `<P>/.codex/hooks.json`, `<P>/.codex/r2c-hook-*.cmd` |
| `dsh` | user | `~/.dsh/profiles/<profile>/package.json` (`r2c-adapter-dsh` dependency + `dsh.profile.bundles`), `~/.dsh/profiles/<profile>/cordis.patch.yml`, payload `adapters/dsh/{index.mjs,package.json,cordis.patch.yml,hooks.json}` |
| `omp` | project | `<P>/.omp/commands/`, `<P>/.omp/skills/`, `<P>/.omp/agents/r2c-*.md`, `<P>/.omp/hooks/{pre,post}/`, `<P>/.omp/mcp.json` |
| | user | `~/.omp/agent/{commands,skills,agents,hooks,mcp.json}` |
| `opencode` | project | `<P>/.opencode/{commands,skills,agents,plugins}/`, `<P>/opencode.json` `mcp` |
| | user | `~/.config/opencode/{commands,skills,agents,plugins}/`, `~/.config/opencode/opencode.json` |

Every install writes a receipt to `<state>/install/<agent>.json`: payload
version and sha256, engine version and `requires.engine`, `runner_cmd`, agent
binary and version, every installed file with its sha256, merged entries,
backups and created directories. `adapter doctor` and `adapter uninstall` both
read that receipt; nothing is deleted by guesswork.

`--profile <name>` selects the dsh profile (default `web`). dsh also needs a
restart after install/uninstall for the bundle and patch to load. Codex command
discovery is via `.agents/skills`; its Stop/PreToolUse hooks only run after you
trust them in `/hooks`, which is a manual step (see below).

## First run

Every install materialises the payload at `<state>/payload/<V>/` and copies its
layout — `workflows/`, `tasks/` and `skills/` — file by file into the project
root, so `r2c run` discovers the manifest with no manual copy. Each copied file
is recorded in the receipt with its project-relative path and sha256, so
`adapter doctor` reports a hand-edited copy and `adapter uninstall` reverts
exactly those files and the directories the install created.

```bash
npx r2c-runner adapter install <agent> --from r2c-payload-0.1.0.tgz --project .
npx r2c-runner run --project .
```

A same-name file the receipt does not own aborts the install with `CONFLICT`
and writes nothing; `--force` backs it up under `.r2c/install/backup/` first.
Terminal-only runs may still point at another manifest with `--manifest`
(absolute path required, and the printed Submit line carries it).
`r2c run --dry-run` reports the discovered manifest and writes no state, which
is the cheapest way to confirm the layout landed.

`--project` and `--project-root` are aliases on every command.

## Doctor

```bash
npx r2c-runner adapter doctor <agent> --project .
```

Zero-model checks, each reported as pass/warn/fail:

- `agent.detected` / `agent.version` — outside `requires.agent` is a warning;
- `engine.version` — outside `requires.engine` is a failure;
- `receipt.present` — missing receipt exits `4`;
- `receipt.files` — a sha256 mismatch fails;
- `hooks.wired`, `hooks.smoke`, `hooks.launch` — the carrier contains this
  payload's shim, parses, and the configured command really launches;
- `hooks.sandbox_write` (dsh/codex) — the hook can write project `.r2c`;
- `plugin.activated` (dsh) — the Cordis bundle is active;
- `discovery` — runs `smoke.mjs`, which does not call a model;
- `manual` — always a warning, listing the agent's manual steps;
- `scope.conflict` — the same agent installed at two scopes with different
  versions.

`adapter smoke <agent>` re-runs just the discovery probe. `adapter prune`
deletes payloads, backups and cache entries no receipt references.

## Upgrade

Versions are locked-step: engine, payload and all five adapters share `V`. The
version source of truth is `package.json.version`, and `npx r2c-runner`
resolves the version the project pins.

1. Install the new engine (`npx r2c-runner@<V>` or the pinned spec).
2. Re-run `adapter install <agent>` with the new engine and no `--plugin`
   override. The payload version defaults to the engine version, so the
   installer materialises `<state>/payload/<V>/` and rewires hooks and Submit
   lines to it.
3. Re-run `adapter doctor <agent>`. The receipt now records
   `payload.version = <V>` and `engine.version = <V>`.

Adapters can be upgraded independently — upgrading `claude-code` does not touch
`codex` — and re-running the same version is a no-op. Installing another
version retires the previous one: the engine and payload directories that the
replacing receipt owned are removed once no other receipt references them, so
`.r2c/engine/` and `.r2c/payload/` hold the versions in use, not a history. A
payload whose `engine` range does not match the engine fails the install gate
(exit `2`) for `--copy`; `--link` only warns, because the linked files are
shared in place.

## Rollback

Rollback means going back to the matching set: **old engine + that engine's
payload**. Re-install the chosen agent with the old engine and its payload,
allowing the overwrite:

```bash
npx r2c-runner@<old-V> adapter install <agent> \
  --from <old-payload-dir|r2c-payload-<old-V>.tgz> --force --project .
npx r2c-runner@<old-V> adapter doctor <agent> --project .
```

`--from` can be replaced by `--plugin <old-V>` when the old payload is already
cached under `~/.r2c/cache/payload-<old-V>`. `--force` covers any target the
receipt does not know about (hand-edited files, files left by another tool);
files the newer install owned are replaced and backed up from the receipt. The
receipt is rewritten with the old payload/engine pair, and the newer engine and
payload directories are removed once no receipt references them, so `doctor`
sees one consistent set. Files that exist only in the newer payload have no
counterpart in the old plan and stay behind — check the agent's install
directory afterwards and delete what the old version never installed.

**Pointing `PATH` back at an older engine is not a rollback.** The receipt
still pins the newer payload, every hook and Submit line still invokes the
newer shim, and `doctor` reports the mismatch as a failure. A half-reverted
install also leaves runs created by the newer engine with a state schema the
older engine may refuse (`STATE_SCHEMA_NEWER`); do not roll back below the
schema of the runs you intend to continue.

## Uninstall

```bash
npx r2c-runner adapter uninstall <agent> --project .
```

Uninstall deletes exactly the files listed in the receipt — agent config and the
project-root layout copies alike — removes only the
JSON entries and hook items this install merged (never a neighbour's), deletes
self-created empty directories without going above the install root, and drops
the payload and the engine only when no receipt still references them. A file
whose sha256 no longer matches the receipt is not deleted; it is reported in
`leftover[]` for manual review (`--force` deletes it anyway). Runtime state under
`.r2c/` — runs, events, usage, business artifacts — is **kept** by default so a
later reinstall or `r2c status` still sees the history.

`--purge-state` additionally removes the runtime paths
(`.r2c/runs/`, `.r2c/usage/`, `.r2c/latest.json`), every installed payload under
`.r2c/payload/` and the receipts directory `.r2c/install/`. Business artifacts
(`.r2c/ir.md`, `.r2c/sr-map.md`, `.r2c/artifacts/**`) are not touched. Anything
the installer cannot own safely is reported in `leftover[]` for manual cleanup;
dsh additionally needs a restart after uninstall.

## Exit codes

`0` success and idempotent no-op · `1` internal error · `2` usage, manifest or
conflict error · `3` gate, smoke or validation failure · `4` agent not
detected or adapter not installed · `5` lock conflict.

## B and C have no runtime guard

The pre-tool-use guard (`.r2c/runs/**`, `.r2c/usage/**`, `.r2c/latest.json`,
workflow manifests) exists only when an A/A′ install wires the hook — and for
Codex only after `/hooks` trust, which has no programmatic switch. Under **B**
(an adapter is installed but its hook does not fire) and **C** (no adapter at
all) the runner cannot intercept tool calls: a model can still write the
runtime paths, and only `submit`'s `expect.outputs`/`gate` checks will notice a
wrong result. Do not treat B or C as a protected environment, and do not
describe them as one.
