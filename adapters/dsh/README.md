# dsh adapter

Installs at user scope only: it adds the `r2c-adapter-dsh` bundle to a dsh
profile (`$DSH_HOME/profiles/<profile>`, default `web`) and renders the payload
assets into `<state>/payload/<V>/adapters/dsh/`.

## Landing paths

| Unit | Path |
| --- | --- |
| Profile manifest | `~/.dsh/profiles/<profile>/package.json` (`dependencies` + `dsh.profile.bundles`) |
| Profile patch layer | `~/.dsh/profiles/<profile>/cordis.patch.yml` |
| Plugin module | `<payload>/adapters/dsh/index.mjs` |
| Bundle patch | `<payload>/adapters/dsh/cordis.patch.yml` |
| Hook fallback | `<payload>/adapters/dsh/hooks.json` |
| MCP (opt-in) | rows appended to the bundle patch, removed on uninstall |

## Install

Through the release bootstrap (it forwards `--profile` and `--scope`):

```bash
node .r2c/bootstrap/install.mjs --agent dsh --version <V> --scope user --profile web
```

Or with an engine that is already on disk:

```bash
node ~/.r2c/engine/<V>/bin/r2c.js adapter install dsh --profile web
node ~/.r2c/engine/<V>/bin/r2c.js adapter doctor dsh
node ~/.r2c/engine/<V>/bin/r2c.js adapter uninstall dsh
```

dsh is user scope only, so the engine lives at `~/.r2c/engine/<V>/`. The engine
resolves `r2c-payload-<V>.tgz` from the GitHub Release at its own version; add
`--from <payload-dir|r2c-payload-<V>.tgz>` for an offline install.

The native command `dsh plugin --profile <name> add link:<payload>/adapters/dsh`
is used when available; otherwise the profile manifest is merged directly and
the receipt records `mode: "dsh-plugin+manual-merge"`.

## Restart and activation

dsh loads profile bundles at boot: restart dsh after install or uninstall. An
activation failure is a warning in dsh, so `doctor` treats
`plugin.activated` (`warning: N entry did not activate`) as a failure. The
`hooks.json` path is a compatibility fallback only; the native Cordis seam
(`agent/turn-stopping`, `tools/pre-execute`) is the primary carrier.

`DSH_SESSION_ID` makes B mode self-sufficient in headless runs.

## Failure modes

- Plugin activation warning only: `doctor` fails `plugin.activated`.
- Hook sandbox cannot write project `.r2c`: `doctor` fails
  `hooks.sandbox_write`.
- The bridge hook gets its exit code flattened by pwsh, so denial is emitted as
  exit 0 + `hookSpecificOutput.permissionDecision = "deny"`.
