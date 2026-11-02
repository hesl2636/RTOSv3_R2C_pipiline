# Install, upgrade, rollback, uninstall

One channel: the four assets of a GitHub Release of
`hesl2636/hm2B_drvport_pipiline` — `r2c-engine-<V>.tgz`, `r2c-payload-<V>.tgz`,
`install.mjs` and `SHA256SUMS.txt`. There is no npm channel and no manual
payload copy. `install.mjs` downloads the engine archive, verifies it against
`SHA256SUMS.txt`, extracts it to `<project>/.r2c/engine/<V>/` (project scope)
or `~/.r2c/engine/<V>/` (user scope), then runs that engine's
`adapter install <agent> --engine <home> --scope <scope> --project <dir>`.

The engine then resolves `r2c-payload-<V>.tgz` from the same release, verifies
every `r2c-payload.json` hash, materialises it at `<state>/payload/<V>/`, copies
the layout (`workflows/`, `tasks/`, `skills/`) into the project root, writes the
agent configuration and records the receipt. Engine, payload and adapters are
one version set: `V` is `0.1.0` while `docs/compat.md` says so.

`<agent>` is one of `claude-code`, `codex`, `dsh`, `omp`, `opencode`.
`adapter list` prints the same matrix that [docs/compat.md](compat.md) is
generated from. Per-agent landing paths and hook wiring are in
`adapters/<agent>/README.md` (starting with
[claude-code](../adapters/claude-code/README.md)).

## Prerequisites

- Node `>=22.19.0 <23 || >=24.0.0`; the engine refuses to start outside it and
  so does the bootstrap.
- The CLI of the agent you are installing for, on `PATH`. The engine detects it
  with the probes in `adapter.json` (`detect.commands`, `detect.paths`) and
  exits `4` with `AGENT_NOT_DETECTED` when neither matches. Install the agent
  first, or bypass detection with the engine's
  `adapter install --agent <id>` form (option instead of positional; it records
  a warning instead of failing).
- `gh`, a plain HTTPS download (`curl` or PowerShell `Invoke-WebRequest`), a
  repository checkout, or a local copy of the release assets (see [Offline and
  private downloads](#offline-and-private-downloads)). No npm.
- Write access to the target scope's directories (see [Scopes and landing
  paths](#scopes-and-landing-paths)).

## Install

Run every command from the project root. `--agent` is required; `--scope`
defaults to `project`; `--project` defaults to the current directory;
`--version` defaults to the latest formal release.

Without `gh` and without a checkout, download the published bootstrap over
HTTPS. This is the path for an external machine. The example uses `opencode`;
substitute another adapter id and its extra flags from the matrix below.

POSIX:

```bash
mkdir -p .r2c/bootstrap
curl -fL -o .r2c/bootstrap/install.mjs https://github.com/hesl2636/hm2B_drvport_pipiline/releases/download/v0.1.0/install.mjs
node .r2c/bootstrap/install.mjs --agent opencode --version 0.1.0 --project .
```

Windows (PowerShell):

```powershell
New-Item -ItemType Directory -Force .r2c\bootstrap | Out-Null
Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/hesl2636/hm2B_drvport_pipiline/releases/download/v0.1.0/install.mjs' -OutFile '.r2c\bootstrap\install.mjs'
node '.r2c\bootstrap\install.mjs' --agent opencode --version 0.1.0 --project '.'
```

A public repository only removes the authorization requirement. An anonymous
release download can still fail at the network layer with `fetch failed`; set
`GH_TOKEN` and rerun the same `node` command to make the bootstrap read the
assets through the GitHub API.

With `gh`, POSIX:

```bash
mkdir -p .r2c/bootstrap
gh release download v0.1.0 -R hesl2636/hm2B_drvport_pipiline -p install.mjs --dir .r2c/bootstrap
node .r2c/bootstrap/install.mjs --agent claude-code --version 0.1.0 --project .
```

With `gh`, Windows (cmd or PowerShell):

```bat
mkdir .r2c\bootstrap
gh release download v0.1.0 -R hesl2636/hm2B_drvport_pipiline -p install.mjs --dir ".r2c\bootstrap"
node ".r2c\bootstrap\install.mjs" --agent claude-code --version 0.1.0 --project "."
```

From a repository checkout (`scripts/install.mjs` is the same file the release
publishes as the `install.mjs` asset). The checkout is the project
when you install into it; otherwise pass `--project`:

```bash
node scripts/install.mjs --agent claude-code --version 0.1.0
node scripts/install.mjs --agent claude-code --version 0.1.0 --project "../other project"
```

```bat
node scripts\install.mjs --agent claude-code --version 0.1.0
node scripts\install.mjs --agent claude-code --version 0.1.0 --project "..\other project"
```

Omit `--version` to take the latest formal release; that asks the GitHub API and
is impossible with a local `--release-base` directory, which therefore requires
`--version`.

What the command writes and prints: the engine home, the adapter line, the
payload source, the layout line, the number of files written, and the next
command. Re-running the same version with the same parameters writes nothing
and exits `0`: the engine is found in place and is not downloaded again, while
the payload is still resolved from its source and verified per file against
`r2c-payload.json` before the no-op is reported. A release download—or a
`.tgz` with a `SHA256SUMS.txt` beside it—is additionally checked against that
file before extraction (a release download is staged in a temporary directory,
never cached).

Scope and quoting:

- `--scope project` (the default where `adapter.json` lists both): engine
  `.r2c/engine/<V>/`, payload `.r2c/payload/<V>/`, receipt
  `.r2c/install/<agent>.json`. The installed hooks and Submit lines carry
  `node .r2c/engine/<V>/bin/r2c.js` — relative to the project root, so renaming
  or moving the project keeps them working.
- `--scope user`: engine `~/.r2c/engine/<V>/`, payload `~/.r2c/payload/<V>/`,
  receipts `~/.r2c/install/`, agent configuration under the user home. The
  installed command is the engine's absolute path, quoted when it contains
  spaces, because the agent's working directory is not the project. The layout
  still lands in `--project`. `dsh` is user scope only and rejects
  `--scope project`.
- Quote any path with spaces or non-ASCII characters: `--project "C:\work\my
  project"` (Windows) and `--project "$HOME/my project"` (POSIX). `~` expands in
  POSIX shells only; use `%USERPROFILE%` in cmd and `$env:USERPROFILE` in
  PowerShell. `--runner-cmd "node \"C:/tools/r2c/bin/r2c.js\""` is the only
  supported manual override of the installed command.

Two flags are forwarded to the engine's `adapter install`:

- `--force` backs up and replaces files another install owns. That is what a
  second adapter in the same project needs: the layout (`workflows/`,
  `tasks/`, `skills/`) already belongs to the first adapter's receipt, so the
  conflict rule refuses to overwrite it silently. Each replaced file is copied
  under `.r2c/install/backup/<agent>/` first. Without it the bootstrap exits
  with the engine's `2` and a `CONFLICT` error.
- `--profile <name>` selects the dsh profile (default `web`; pass
  `--scope user` too, dsh is user-scoped) and is ignored by the other adapters.

After the install the layout is already in the project root: `r2c run`
discovers `workflows/hm2B_drvport_pipiline.yaml` with no further step, and
`r2c run --dry-run` prints the discovered manifest without writing state.

```bash
node .r2c/engine/0.1.0/bin/r2c.js run --dry-run
```

Next: `node .r2c/engine/0.1.0/bin/r2c.js run` in the project root (Windows: `node ".r2c\engine\0.1.0\bin\r2c.js" run`).

## Upgrade

Upgrade is a re-install at the new version: engine, payload and adapters move
together. Download the new `install.mjs` if you keep it under `.r2c/bootstrap/`
(the file is the same in every release), then run:

```bash
node .r2c/bootstrap/install.mjs --agent claude-code --version <new-V> --project .
```

```bat
node ".r2c\bootstrap\install.mjs" --agent claude-code --version <new-V> --project "."
```

From a checkout the equivalent is `node scripts/install.mjs --agent <id>
--version <new-V>`. What changes:

- the new engine is extracted to `.r2c/engine/<new-V>/` and the new payload to
  `.r2c/payload/<new-V>/`; hooks, Submit lines and the receipt point at the new
  entry;
- the previous engine and payload that this receipt owned are removed once no
  other receipt still references them, so one agent upgraded alone keeps the old
  set alive for the agents still on it; `--dry-run` lists the removals;
- layout files are written from the new payload and the receipt is rewritten;
  a file only the old payload carried is removed when it still matches the
  receipt, and kept with a `layout-stale:` warning when you edited it;
- `--plugin <V>` (an `adapter install` option the bootstrap does not pass) pins a
  payload version different from the engine; leave it out to move both;
- the same version with the same parameters is a no-op: exit `0` and no writes;
- upgrading one adapter does not touch another.

Each agent is upgraded by re-running the command with its own id, then verified
with `adapter doctor` (see [Doctor](#doctor)), which also checks that the
recorded engine entry really runs at the recorded version.

Next: `node .r2c/engine/<new-V>/bin/r2c.js run` in the project root.

## Rollback

Rollback means installing the older version set again — engine, payload and
adapters at `<old-V>` — not pointing `PATH` at an older engine. The receipt,
the hooks and the Submit lines keep the entry they were installed with, so a
`PATH` change reverts nothing.

```bash
node .r2c/bootstrap/install.mjs --agent claude-code --version <old-V> --project .
```

```bat
node ".r2c\bootstrap\install.mjs" --agent claude-code --version <old-V> --project "."
```

The old payload resolves from `~/.r2c/cache/payload-<old-V>` when that version
was installed from a tgz before, otherwise from release `v<old-V>`. Both the old
engine and the old payload are verified before anything lands, the newer set is
retired as in [Upgrade](#upgrade), and layout files that exist only in the newer
payload are removed by the same rule: an unmodified copy is deleted, a
hand-edited copy stays behind with a `layout-stale:` warning.

If the re-install stops with `CONFLICT`, some target is a file the old receipt
does not own (hand-edited, or written by the newer set under another name). The
old engine is already on disk at that point, so finish with the explicit
overwrite, which backs each file up under `.r2c/install/backup/` first:

```bash
node .r2c/engine/<old-V>/bin/r2c.js adapter install claude-code --scope project --project . --force
```

```bat
node ".r2c\engine\<old-V>\bin\r2c.js" adapter install claude-code --scope project --project "." --force
```

Rolled-back runs continue from the project's `.r2c/runs`; an engine older than
the state schema of those runs refuses them with `STATE_SCHEMA_NEWER`.

Next: `node .r2c/engine/<old-V>/bin/r2c.js adapter doctor claude-code --project .`

## Uninstall

Use the engine entry the install wrote; it is removed only when no receipt still
references it.

```bash
node .r2c/engine/0.1.0/bin/r2c.js adapter uninstall claude-code --project .
```

```bat
node ".r2c\engine\0.1.0\bin\r2c.js" adapter uninstall claude-code --project "."
```

For a user-scope install pass `--scope user` and use
`~/.r2c/engine/<V>/bin/r2c.js` as the entry.

Uninstall deletes exactly the files listed in the receipt — agent configuration
and the project-root layout copies alike — removes only the JSON entries and
hook items this install merged (never a neighbour's), deletes self-created empty
directories without going above the install root, and drops the payload and the
engine only when no receipt still references them. A file whose sha256 no
longer matches the receipt is not deleted; it is reported in `leftover[]` for
manual review (`--force` deletes it anyway). Runtime state under `.r2c/` — runs,
events, usage, business artifacts — is **kept** by default so a later reinstall
or `r2c status` still sees the history.

`--purge-state` additionally removes the runtime paths (`.r2c/runs/`,
`.r2c/usage/`, `.r2c/latest.json`), every installed payload under
`.r2c/payload/` and the receipts and backups under `.r2c/install/`. Business
artifacts (`.r2c/ir.md`, `.r2c/sr-map.md`, `.r2c/artifacts/**`) are not touched.
`dsh` needs a restart after install or uninstall for the bundle and patch to
load.

Next: `git status --short` in the project root, to review the layout files the uninstall reverted before you commit.

## Legacy migration

A project that still carries the old `r2c.install/v1` receipts — one
`.r2c/install/<agent>.json` per adapter — cannot receive a bundle install: the
new channel refuses with `LEGACY_INSTALL_PRESENT` before it writes anything.
Take the project over explicitly:

```bash
node installer/cli.js --result <projection-result-dir> --project . --migrate-legacy
```

The takeover is one transaction, and it only proceeds after every recorded
`sha256` matches the file on disk:

1. every path the legacy install touched is copied to
   `.r2c/install/backup/<projection>/<bundle>/<stamp>/<path>`;
2. merged JSON entries (`settings.json` hooks, `opencode.json`/`.mcp.json`
   pointers) are revoked one pointer at a time and never rewritten wholesale;
3. the old layout files and links are deleted, empty `dirs_created`
   directories are pruned, and unreferenced `.r2c/payload/<V>/` trees go;
4. each receipt moves to `.r2c/install/legacy/<agent>.json.retired` (kept for
   audit, never read again), and the new `r2c.install/v2` receipt records it in
   `migrated_from`;
5. the new projection is written in the same journal, so any failure restores
   the legacy bytes and receipts.

A file modified after the legacy install is a `LEGACY_HASH_MISMATCH` conflict;
`--force` backs that file up and continues instead. A receipt with an
unsupported `r2c.install/*` schema aborts the migration untouched.

User-scope leftovers — `~/.r2c/install/<agent>.json` and the engine/payload
under `~/.r2c/` — are outside the project and are **never** touched. The
install summary prints them as manual steps, together with the note that rows
the legacy channel merged into `$DSH_HOME/profiles/<profile>/cordis.patch.yml`
must be removed by hand. Only project-scope receipts are migrated.

## Offline and private downloads

### Credentials

A public repository is read anonymously, but public visibility does not
guarantee the download route: an anonymous `fetch failed` is a network failure,
not a missing permission. Setting a credential switches the bootstrap to the
GitHub API asset path below and is the supported workaround. A private
repository answers the anonymous request with `404`, so the bootstrap and the
payload downloader walk the same chain: `GH_TOKEN` → `GITHUB_TOKEN` →
`git credential fill` for
`protocol=https`, `host=github.com`. The helper call never prompts
(`GIT_TERMINAL_PROMPT=0`) and times out after a few seconds, so an unattended
install cannot hang; when none of the three yields a credential the error names
the missing credential and suggests `gh auth login` instead of reporting a plain
`404`.

With a token the assets are read through the GitHub API
(`/releases/tags/v<V>` plus `/releases/assets/<id>` with
`Accept: application/octet-stream`), because the web download URL answers `404`
to a bearer token. `gh auth login` stores its token in `gh`'s own config, so
publish it to the installer when you rely on it:

```bash
export GH_TOKEN="$(gh auth token)"
```

```powershell
$env:GH_TOKEN = (gh auth token)
```

`gh auth setup-git` makes the same token visible to `git credential fill`. A
custom release base (`R2C_RELEASE_BASE`, below) never receives the GitHub
credential: a mirror authenticates on its own.

### Cache

`~/.r2c/cache/payload-<V>` (the home is `R2C_HOME`, else `HOME`/`USERPROFILE`,
else the OS home). Resolution order for the payload is `--from <dir|tgz>` →
`R2C_PLUGIN_SOURCE` → the cache → the release download. The cache is filled by
installing from a tgz (`--from`): a release download is staged in a temporary
directory and becomes the payload home, it is not cached. So a repeated offline
install needs either the cache, `--from`, or a local release base.

The engine archive is not cached: it lives at `.r2c/engine/<V>/` (or
`~/.r2c/engine/<V>/`) and is replaced in place. Re-running the bootstrap for the
same version finds it there and downloads nothing.

### Local mirror and `--from`

`node scripts/release.mjs --out dist` produces exactly the release: a flat
directory holding `r2c-engine-<V>.tgz`, `r2c-payload-<V>.tgz`, `install.mjs` and
`SHA256SUMS.txt`. Point the bootstrap at such a directory with
`--release-base <dir>` (or `R2C_RELEASE_BASE`): nothing is fetched, `--version`
is required, and the base is passed on to the engine so the payload comes from
the same directory. An http(s) base instead mirrors GitHub's layout and is read
as `<base>/v<V>/<asset>`:

```bash
node scripts/install.mjs --agent claude-code --version 0.1.0 --release-base dist
node .r2c/bootstrap/install.mjs --agent claude-code --version 0.1.0 --release-base "/srv/r2c/releases"
```

```bat
node scripts\install.mjs --agent claude-code --version 0.1.0 --release-base "D:\r2c\releases"
```

For the adapter step alone, `adapter install --from <dir|tgz>` accepts an
unpacked payload (a directory with `r2c-payload.json`, or a source checkout
containing `package.json`, `pack/` and `adapters/`) or the release tgz. A tgz is
verified against every `r2c-payload.json` hash, and against a
`SHA256SUMS.txt` beside it when one is present, before anything is written;
it is then cached under `~/.r2c/cache/payload-<V>`. `--link` is accepted only
together with `--from <dir>`: a tgz always installs with `--copy`.

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

Every install writes a receipt to `<state>/install/<agent>.json`: scope,
project root, engine home and entry, payload version and sha256, `runner_cmd`,
agent binary and version, every installed file with its sha256, merged entries,
backups and created directories. `adapter doctor` and `adapter uninstall` both
read that receipt; nothing is deleted by guesswork.

`--profile <name>` selects the dsh profile (default `web`). Codex command
discovery is via `.agents/skills`; its Stop/PreToolUse hooks only run after you
trust them in `/hooks`, which is a manual step (see below).

## Payload resolution

`--from <dir|tgz>` → `R2C_PLUGIN_SOURCE` → `~/.r2c/cache/payload-<V>` → the
release (a flat `--release-base` directory or an http(s) base). `--plugin <V>`
selects a cached payload version instead of the engine version; `--from` takes
precedence over it. `R2C_PLUGIN_SOURCE`, `--plugin` and the `r2c.plugin/v1`
manifest id keep their historical name on purpose; [GLOSSARY.md](../GLOSSARY.md)
records them as the documented exceptions to the payload vocabulary.

Before anything is written the installer runs: detection → payload
resolution/verification → engine and agent version gates → plan (`--dry-run`
prints it and exits) → conflict scan → pending marker → backups → atomic
writes → post-install smoke → receipt. A conflict with an unowned file fails
with exit `2`; `--force` backs the file up and replaces it. Installing the same
payload with the same options a second time performs no writes, reports
`action:"noop"`, `changed:false`, and exits `0`.

## Doctor

```bash
node .r2c/engine/0.1.0/bin/r2c.js adapter doctor <agent> --project .
```

Zero-model checks, each reported as pass/warn/fail:

- `receipt.present` — missing receipt exits `4`;
- `agent.detected` / `agent.version` — outside `requires.agent` is a warning;
- `engine.version` — outside `requires.engine` is a failure;
- `engine.executable` — the recorded entry really runs and reports the recorded
  version;
- `receipt.files` — a sha256 mismatch fails, and so does a missing layout copy;
- `hooks.wired`, `hooks.smoke`, `hooks.launch` — the carrier contains this
  payload's shim, parses, and the configured command really launches;
- `hooks.sandbox_write` (dsh/codex) — the hook can write project `.r2c`;
- `plugin.activated` (dsh) — the Cordis bundle is active;
- `discovery` — runs `smoke.mjs`, which does not call a model;
- `manual` — always a warning, listing the agent's manual steps;
- `scope.conflict` — the same agent installed at two scopes with different
  versions.

`adapter smoke <agent>` re-runs just the discovery probe. `adapter prune`
deletes engines, payloads, backups and cache entries no receipt references.

## Exit codes

Engine: `0` success and idempotent no-op · `1` internal error · `2` usage,
manifest or conflict error · `3` gate, smoke or validation failure · `4` agent
not detected or adapter not installed · `5` lock conflict.

Bootstrap: `0` success · `1` download, asset or spawn failure · `2` usage
(including an unsupported Node, refused before anything is downloaded) · `3`
engine-archive checksum or extraction failure. A failing `adapter install`
keeps its own exit code (`2`–`5`) instead of `1`.

## B and C have no runtime guard

The pre-tool-use guard (`.r2c/runs/**`, `.r2c/usage/**`, `.r2c/latest.json`,
workflow manifests) exists only when an A/A′ install wires the hook — and for
Codex only after `/hooks` trust, which has no programmatic switch. Under **B**
(an adapter is installed but its hook does not fire) and **C** (no adapter at
all) the runner cannot intercept tool calls: a model can still write the
runtime paths, and only `submit`'s `expect.outputs`/`gate` checks will notice a
wrong result. Do not treat B or C as a protected environment, and do not
describe them as one.
