# opencode adapter (V1)

Declarative adapter for opencode 1.19.x. The engine installer
(`r2c adapter install opencode`) reads `adapter.json` + `map.json` and performs
every write; this directory holds no install logic.

## Landing paths (project scope, default)

| Kind | Path |
|---|---|
| Commands (7 × `r2c-*`) | `<P>/.opencode/commands/r2c-<id>.md` |
| Skills (35 placeholder skills) | `<P>/.opencode/skills/<id>/SKILL.md` |
| Child agents (derived from manifest roles) | `<P>/.opencode/agents/r2c-<role>.md` (`mode: subagent`) |
| Plugin (A′ hand-off) | `<P>/.opencode/plugins/r2c.ts` |
| MCP servers | `<P>/opencode.json` `mcp.<id>`; `--mcp <file>` carries `{"mcp": { "<id>": {…} }}` |

User scope (`--scope user`) writes
`~/.config/opencode/{commands,skills,agents,plugins}` and
`~/.config/opencode/opencode.json` for MCP.

`--link` is only accepted with `--from <dir>`. It links the skills directory
(junction on Windows, directory symlink on POSIX); flat command, agent and
plugin files are copied and reported as `link-unsupported:<path>`.

## How A′ works

The plugin subscribes to `session.idle`, resolves the session id from the
event, and calls the shared shim:

```text
node "<PAYLOAD_HOME>/shims/hook.mjs" stop --agent opencode --event stop \
  --format plain --runner-cmd "<RUNNER_CMD>" --project-root <P> \
  --session-id <sid> --cap 32
```

`hook stop` (not `next`) gives the same plain body **and** the one-time claim
channel: a run minted as `cli-<runId>` is bound to the real session on the
first idle. The plugin injects the text as a new user turn through
`client.session.prompt` only when the output is non-empty.

Watermarks: one injection per `(run_id, step_id)`, and at most 32 injections
per run. A same-step idle is ignored before the shim is called. The idle handler
never throws; a missing run is an empty-output hook stop, so nothing is
injected.

`tool.execute.before` forwards the tool call to the shim's
`hook pre-tool-use`. Exit 2 becomes `throw new Error(reason)`; every other exit
code passes.

## V1 pin and B-mode fallback

`requires.agent` is `>=1.19.5 <2`. `doctor` reports `agent.version` and
`platform.pin`; a version outside the pin is a warning, never a hard failure:

- V1 (1.19.x): A′ as described.
- No V1 plugin / version outside the pin: A′ is unavailable. The install still
  works and the adapter degrades to **B**: run `r2c next --format plain`
  manually. `doctor` reports `plugin.loaded` as a warning
  because opencode's plugin registry cannot be probed without a live session.

## Install / verify / remove

```bash
node .r2c/engine/<V>/bin/r2c.js adapter install opencode --project .
node .r2c/engine/<V>/bin/r2c.js adapter doctor opencode --project .
node .r2c/engine/<V>/bin/r2c.js adapter smoke opencode --project .
node .r2c/engine/<V>/bin/r2c.js adapter uninstall opencode --project .
```

The engine resolves `r2c-payload-<V>.tgz` from the GitHub Release at its own
version; `--from` accepts an unpacked payload (`r2c-payload.json`) or a source
checkout (`package.json` + `pack/` + `adapters/`) for an offline install.

## Manual steps

- Keep opencode on V1 (`>=1.19.5 <2`). V2 has a different plugin API and is out
  of scope; its absence is the documented B-mode fallback.
- `opencode run --command r2c-status` is a live check; the zero-model
  `smoke.mjs` only asserts that the command and skill files are discoverable.

## Uninstall

`r2c adapter uninstall opencode` deletes exactly the receipt files (including
the plugin), removes only the `mcp` keys this install merged, recycles
self-created empty directories, and keeps `.r2c` runtime state. No agent-side
residue is expected.
