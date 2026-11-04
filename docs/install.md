# Install

One forward channel: a per-bundle Release (`bundle-<id>-v<version>`) installed
by the Release's own `install.mjs`. The pre-P6 legacy channel (`v<engine>`) is
frozen: those tags and their installers keep working, but main no longer
builds or publishes a payload for them.

## Install

```bash
node install.mjs --bundle rtosv3-drvport --version 1.0.0 --projection runner --project .
node .hm2b/bin/hm2b.js status
```

The web build and published results list one command per agent, plus a separate
runner command. Select **Windows PowerShell** or **macOS / Linux (Bash)** before
copying. All commands use the same Release's `install` launcher, with the bundle
id, version and allowed projections pinned.

### One command per agent

Run one of these commands in the target project root. These are PowerShell
commands: `curl.exe` bypasses Windows PowerShell's `curl` alias for
`Invoke-WebRequest`. On macOS/Linux (Bash), replace `curl.exe` with `curl`.

**OMP (Oh My Pi)**

```powershell
curl.exe -fsSL https://github.com/hesl2636/hm2B_drvport_pipiline/releases/download/bundle-rtosv3-drvport-v1.0.0/install | node - --target omp
```

**OpenCode**

```powershell
curl.exe -fsSL https://github.com/hesl2636/hm2B_drvport_pipiline/releases/download/bundle-rtosv3-drvport-v1.0.0/install | node - --target opencode
```

**Codex**

```powershell
curl.exe -fsSL https://github.com/hesl2636/hm2B_drvport_pipiline/releases/download/bundle-rtosv3-drvport-v1.0.0/install | node - --target codex
```

**Claude Code**

```powershell
curl.exe -fsSL https://github.com/hesl2636/hm2B_drvport_pipiline/releases/download/bundle-rtosv3-drvport-v1.0.0/install | node - --target claude-code
```

**dsh**

```powershell
curl.exe -fsSL https://github.com/hesl2636/hm2B_drvport_pipiline/releases/download/bundle-rtosv3-drvport-v1.0.0/install | node - --target dsh
```

Each agent command installs agent-native skills and roles for that host. An
agent can invoke an individual skill or stage without running the entire
workflow. Progress and acceptance checks are maintained by the executor rather
than enforced by a runner.

### Runner: managed workflow, all supported hosts

```powershell
curl.exe -fsSL https://github.com/hesl2636/hm2B_drvport_pipiline/releases/download/bundle-rtosv3-drvport-v1.0.0/install | node - --projection runner
```

Runner records progress, controls step order and enforces output/gate checks.
Its installed skills can also be invoked individually through the host.
This Release entry installs runner integrations for all supported hosts;
`--target` selects agent-native, not a subset of runner hosts.

The default is `runner`; `--target <id>` (repeatable) selects agent-native for
those hosts, and `--projection agent-native` installs every host. Runner and
agent-native own overlapping host role paths, so one project installs exactly
one projection. `--project <dir>` and `--force` are the only other flags; no
`gh` login or whole-Release pre-download is involved. The installer reads
`GH_TOKEN`, then `GITHUB_TOKEN`, then a github.com credential when the
repository is private.

For a private repository, download `install` from its signed-in Release page
first, then run `node install` with the same optional flags. The launcher
fetches private assets through the GitHub API and verifies its pinned
`install.mjs` SHA-256 before executing it. `GH_REPO=owner/name` at build time
pins the launcher and its installer to that publishing repository.
Use the same `GH_REPO` when publishing an existing build directory; a different
repository is rejected before any GitHub write and requires a rebuild.

If the tag is already published, do not reuse it: type the next patch (for
example `1.0.1`) into the web page's **版本** field before uploading. The server
rewrites `bundle.json`, recompiles, and the **构建并发布** button publishes that
new tag in one step. A published Release is never overwritten.

The web server reads the local `gh auth token` at startup, so publishing needs
no `GH_TOKEN` wrapper. Set `HM2B_WEB_GH_AUTH=off` to keep the surface read-only.

`--projection agent-native` installs only host files and one receipt; it never
installs a runtime. `--target <id>` (repeatable) narrows the host set without
re-projecting; the bundle's `roles.json` is still installed. `--project <dir>`
selects the project root, `--release-base <dir|url>` points at a mirror, and
`--force` is the explicit override for the conflict matrix (it never crosses
another receipt's ownership).

`--release-base` belongs to `install.mjs`; for the flag-free launcher, set
`HM2B_RELEASE_BASE` to the mirror directory or URL instead. Both stages keep
GitHub credentials off custom mirrors, and temporary launcher files are
removed even when the download or installer fails.

The pre-projected payload already carries the bundle's v2 assets: the runner
payload writes `knowledge-base/**`, `checklists/**`, `hooks/hooks.json` and
`mcp.json` at the project root; the agent-native payload writes them once
under `.agents/agent-native/<bundle-id>/` for every selected target. The
installer writes those bytes verbatim and records them in the receipt.

The installer verifies the asset chain before any write:

1. every asset against the Release's `SHA256SUMS.txt`;
2. the bundle zip, `workflow.compiled.json` and the pre-projected payload against
   each other (id, version, compiled workflow digest, content digest);
3. every payload member against `manifest.json`;
4. the payload's `V1–V12` result and the install plan.

A mismatch exits 2 with zero writes. Nothing is compiled or projected at
install time.

## Upgrade

Install the same bundle id at a newer version. The installer diffs the new
payload against the old receipt, backs up and replaces files it owns, removes
paths the new version no longer ships, and keeps hand-edited files with a
`STALE_MODIFIED_KEPT` warning. Unchanged identity/options/files is a no-op with
exit 0. `requires.engine` is evaluated only for the runner projection.

## Rollback

Rollback = install the previous `(id, version)` again. Old Releases are never
rewritten, so the previous bytes are always available. If a run is in progress,
its step sequence may no longer match the old manifest: the runner refuses to continue
with `MANIFEST_STEPS_CHANGED` (exit 2) and does not touch state; finish or
abandon the run before rolling back. Different bundle ids are different
namespaces — uninstall explicitly, never in place.

## Uninstall

```bash
node installer/cli.js --uninstall --bundle rtosv3-drvport --projection runner --project .
```

Uninstall deletes only files recorded in that identity's receipt, prunes empty
directories it created, and keeps `.hm2b/` state. There is no state-purge flag:
runs, `latest.json`, usage, `runtime.json`, the engine and the launcher stay on
disk, and uninstall never removes runtime files. Delete `.hm2b/` yourself only
when you also mean to discard every run and the installed engine. A legacy
`r2c.install/v1` install is retired through takeover, not by uninstalling the
new identity.

## Offline and private downloads

`--release-base <dir>` reads a local mirror laid out as
`<base>/<tag>/<asset>`; `--release-base <url>` points at any HTTPS mirror.
Credentials come from the launch environment only: `GH_TOKEN`, then
`GITHUB_TOKEN`, then `git credential fill` (never an interactive prompt).
A private repository answers 404 without a token; the error names the
credential to fix. The bootstrap checks the Node floor before the first
download. Each asset body has one download budget (300 s by default, raised
with `HM2B_INSTALL_DOWNLOAD_TIMEOUT_MS`); a slow or blocked transfer reports
`RELEASE_DOWNLOAD_FAILED` with the proxy hint instead of an internal error.
Node's `fetch` only reads proxy settings when `NODE_USE_ENV_PROXY=1`.
