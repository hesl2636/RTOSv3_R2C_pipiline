# claude-code adapter

Declarative adapter for Claude Code. The engine installer (`r2c adapter
install claude-code`) reads `adapter.json` + `map.json` and performs every
write; this directory holds no install logic.

## Landing paths (project scope, default)

| Kind | Path |
|---|---|
| Commands (7 × `r2c-*`) | `<P>/.claude/commands/r2c-<id>.md` |
| Skills (35 placeholder skills) | `<P>/.claude/skills/<id>/SKILL.md` |
| Child agents | derived from manifest `steps[].agent` into `.claude/agents/r2c-*.md` |
| Hooks | `<P>/.claude/settings.json` `hooks.Stop` + `hooks.PreToolUse` |
| MCP servers | `<P>/.mcp.json` `mcpServers.<id>`, only with `--mcp <file>` |

User scope (`--scope user`) writes `~/.claude/{commands,skills,settings.json}`;
MCP is not written there (Claude Code keeps user MCP in `~/.claude.json`, which
is out of the adapter contract).

`--link` is only accepted with `--from <dir>`. It links the skills directory
(junction on Windows, directory symlink on POSIX); flat command files are
copied and reported as `link-unsupported:<path>`.

## Install / verify / remove

```bash
node .r2c/engine/<V>/bin/r2c.js adapter install claude-code --project .
node .r2c/engine/<V>/bin/r2c.js adapter doctor claude-code --project .
node .r2c/engine/<V>/bin/r2c.js adapter smoke claude-code --project .
node .r2c/engine/<V>/bin/r2c.js adapter uninstall claude-code --project .
```

Normally nothing else is needed: the engine resolves `r2c-payload-<V>.tgz` from
the GitHub Release at its own version. `--from` accepts an unpacked payload
(`r2c-payload.json`) or a source checkout (`package.json` + `pack/` +
`adapters/`) for an offline install, and `--link` requires `--from <dir>`.

## Requirements

- Engine `^0.1.0` (hard gate for `--copy`; warning only for `--link`).
- Claude Code `>=2.1.312 <3` (warning only).
- Detection: `claude --version` on `PATH`, or `~/.claude` existing.

## Hooks

Install merges two entries into `.claude/settings.json` (project or user):
`hooks.Stop` and `hooks.PreToolUse`, each invoking
`node "<payload>/shims/hook.mjs" --agent claude-code --event ... --runner-cmd="<runner>"`.
Existing Stop/PreToolUse entries are appended to, never overwritten; uninstall
removes only the items this install added. The shared shim enforces eight
blocks per (run_id, step_id), then exits 0 and points the user at `r2c next`.

`r2c adapter doctor` verifies `hooks.wired` (settings contains this payload's
shim path), `hooks.smoke` (shim present, carrier parses as JSON) and
`hooks.launch` (the configured Stop command really exits 0), plus `discovery`
from `smoke.mjs` — all without a model call.

## Manual steps

- The optional native marketplace flow (`claude plugin marketplace`) is
  documented in the spec as an alternative, not as the supported install path.

## Uninstall

`r2c adapter uninstall claude-code` deletes exactly the receipt files, removes
only the `mcpServers` keys and `hooks.Stop`/`hooks.PreToolUse` items this
install merged, recycles self-created empty directories, and keeps `.r2c`
runtime state. No agent-side residue is expected.
