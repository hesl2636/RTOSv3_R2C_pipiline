# dsh adapter

Installs at user scope only: it adds the `r2c-adapter-dsh` bundle to a dsh
profile (`$DSH_HOME/profiles/<profile>`, default `web`) and renders the payload
plugin assets into `<state>/plugin/<V>/adapters/dsh/`.

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

```bash
npx r2c-runner adapter install dsh --from r2c-plugin-0.1.0.tgz --profile web
npx r2c-runner adapter doctor  dsh
npx r2c-runner adapter uninstall dsh
```

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
