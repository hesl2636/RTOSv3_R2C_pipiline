# claude-code adapter

Declarative adapter for Claude Code. The engine installer (`r2c adapter
install claude-code`) reads `adapter.json` + `map.json` and performs every
write; this directory holds no install logic.

## Landing paths (project scope, default)

| Kind | Path |
|---|---|
| Commands (7 × `r2c-*`) | `<P>/.claude/commands/r2c-<id>.md` |
| Skills (35 placeholder skills) | `<P>/.claude/skills/<id>/SKILL.md` |
| Child agents | not installed in v1 (`capabilities.agents = "none"`) |
| Hooks | `<P>/.claude/settings.json` (declared now, wired by ticket 28) |
| MCP servers | `<P>/.mcp.json` `mcpServers.<id>`, only with `--mcp <file>` |

User scope (`--scope user`) writes `~/.claude/{commands,skills}`; MCP is not
written there (Claude Code keeps user MCP in `~/.claude.json`, which is out of
the adapter contract).

`--link` is only accepted with `--from <dir>`. It links the skills directory
(junction on Windows, directory symlink on POSIX); flat command files are
copied and reported as `link-unsupported:<path>`.

## Install / verify / remove

```bash
r2c adapter install claude-code --from <payload-dir> --project .
r2c adapter doctor claude-code --project .
r2c adapter smoke claude-code --project .
r2c adapter uninstall claude-code --project .
```

`--from` accepts an unpacked payload (`r2c-plugin.json`) or a source checkout
(`package.json` + `pack/` + `adapters/`). It is the supported path while the
release repository is private.

## Requirements

- Engine `^0.1.0` (hard gate for `--copy`; warning only for `--link`).
- Claude Code `>=2.1.312 <3` (warning only).
- Detection: `claude --version` on `PATH`, or `~/.claude` existing.

## Manual steps

- Stop/PreToolUse hook wiring in `.claude/settings.json` is delivered by ticket
  28; until then hooks are declared but not merged, and `doctor` reports
  `hooks.wired` as a warning.
- The optional native marketplace flow (`claude plugin marketplace`) is
  documented in the spec as an alternative, not as the supported install path.

## Uninstall

`r2c adapter uninstall claude-code` deletes exactly the receipt files, removes
only the `mcpServers` keys this install merged, recycles self-created empty
directories, and keeps `.r2c` runtime state. No agent-side residue is expected.
