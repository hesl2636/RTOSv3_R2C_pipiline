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

The web page emits one complete command per target. It first downloads the
whole Release through `gh` into `.hm2b/release/<tag>/`, then installs from that
local directory, so the installer never needs a second network call or a token:

```bash
gh release download bundle-rtosv3-drvport-v1.0.0 \
  --repo hesl2636/hm2B_drvport_pipiline \
  --dir .hm2b/release/bundle-rtosv3-drvport-v1.0.0 --clobber
node .hm2b/release/bundle-rtosv3-drvport-v1.0.0/install.mjs \
  --bundle rtosv3-drvport --version 1.0.0 --projection runner \
  --release-base .hm2b/release --project .
```

`gh` must be logged in (`gh auth login`); the downloaded tree is disposable and
ignored by `git` when `.hm2b/` is ignored.

`--projection agent-native` installs only host files and one receipt; it never
installs a runtime. `--target <id>` (repeatable) narrows the host set without
re-projecting; the bundle's `roles.json` is still installed. `--project <dir>`
selects the project root, `--release-base <dir|url>` points at a mirror, and
`--force` is the explicit override for the conflict matrix (it never crosses
another receipt's ownership).

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
download.
