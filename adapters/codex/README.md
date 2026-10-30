# codex adapter

Installs into the project scope (`.agents/`, `.codex/`) by copying the shared
payload. Commands are emitted as skills under `.agents/skills/r2c-*`; the seven
`r2c-*` ids stay the canonical names.

## Landing paths

| Unit | Path |
| --- | --- |
| Commands (as skills) | `<P>/.agents/skills/r2c-*/SKILL.md` |
| Skills | `<P>/.agents/skills/<id>/SKILL.md` |
| Derived agents | `<P>/.codex/agents/r2c-*.toml` |
| Stop / PreToolUse hooks | `<P>/.codex/hooks.json` |
| Hook launchers | `<P>/.codex/r2c-hook-stop.cmd`, `<P>/.codex/r2c-hook-pre-tool-use.cmd` |

MCP is not supported (`capabilities.mcp = "none"`).

## Install

```bash
npx r2c-runner adapter install codex --from r2c-plugin-0.1.0.tgz --project .
npx r2c-runner adapter doctor  codex --project .
npx r2c-runner adapter uninstall codex --project .
```

## Hooks

The project `.codex/hooks.json` is only trusted after a manual step: run
`/hooks` in codex and trust both r2c hooks (non-interactive:
`--dangerously-bypass-hook-trust`). Until then codex runs nothing and the run
stays in B mode (`r2c next` / `r2c submit`). Hook commands are `.cmd` launchers
so a path with spaces never becomes a silent exit 1.

## Failure modes

- Untrusted hooks: silent, no block, no trace — expected, B mode still works.
- Agent version outside `>=0.165.0 <1` warns; install still succeeds.
- A foreign file under a landing path fails the install with exit 2 unless
  `--force` backs it up first.
