# Install

One forward channel: a per-bundle Release (`bundle-<id>-v<version>`) installed
by the Release's own `install.mjs`. The pre-P6 legacy channel (`v<engine>`) is
frozen: those tags and their installers keep working, but main no longer
builds or publishes a payload for them.

## Install

```bash
node install.mjs --bundle rtosv3-drvport --version 1.0.0 --projection r2c --project .
node .r2c/bin/r2c.js status
```

`--projection agent-native` installs only host files and one receipt; it never
installs a runtime. `--target <id>` (repeatable) narrows the host set without
re-projecting; the bundle's `roles.json` is still installed. `--project <dir>`
selects the project root, `--release-base <dir|url>` points at a mirror, and
`--force` is the explicit override for the conflict matrix (it never crosses
another receipt's ownership).

The installer verifies the asset chain before any write:

1. every asset against the Release's `SHA256SUMS.txt`;
2. the bundle zip, `workflow.ir.json` and the pre-projected payload against
   each other (id, version, IR digest, content digest);
3. every payload member against `payload.manifest.json`;
4. the payload's `V1–V12` result and the install plan.

A mismatch exits 2 with zero writes. Nothing is compiled or projected at
install time.

## Upgrade

Install the same bundle id at a newer version. The installer diffs the new
payload against the old receipt, backs up and replaces files it owns, removes
paths the new version no longer ships, and keeps hand-edited files with a
`STALE_MODIFIED_KEPT` warning. Unchanged identity/options/files is a no-op with
exit 0. `requires.engine` is evaluated only for the r2c projection.

## Rollback

Rollback = install the previous `(id, version)` again. Old Releases are never
rewritten, so the previous bytes are always available. If a run is in progress,
its step sequence may no longer match the old manifest: r2c refuses to continue
with `MANIFEST_STEPS_CHANGED` (exit 2) and does not touch state; finish or
abandon the run before rolling back. Different bundle ids are different
namespaces — uninstall explicitly, never in place.

## Uninstall

```bash
node installer/cli.js --uninstall --bundle rtosv3-drvport --projection r2c --project .
```

Uninstall deletes only files recorded in that identity's receipt, prunes empty
directories it created, and keeps `.r2c/` runtime state. `--purge-state` also
removes runs, `latest.json` and usage. Runtime files (`runtime.json`, engine,
launcher) are removed only with an explicit runtime uninstall; a legacy
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
