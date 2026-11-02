# omp adapter

Installs by copying files into the project (default) or `~/.omp/agent/` (user
scope). No `omp plugin link` is used: that command silently lands in user scope
and leaks across projects.

## Landing paths

| Unit | Path |
| --- | --- |
| Commands | `<P>/.omp/commands/r2c-*.md` |
| Skills | `<P>/.omp/skills/<id>/SKILL.md` |
| Derived agents | `<P>/.omp/agents/r2c-*.md` |
| Stop hook | `<P>/.omp/hooks/post/r2c-stop.ts` |
| PreToolUse guard | `<P>/.omp/hooks/pre/r2c-guard.ts` |
| MCP (opt-in) | `<P>/.omp/mcp.json` |

## Install

```bash
node .r2c/engine/<V>/bin/r2c.js adapter install omp --project .
node .r2c/engine/<V>/bin/r2c.js adapter doctor omp --project .
node .r2c/engine/<V>/bin/r2c.js adapter uninstall omp --project .
```

The engine resolves `r2c-payload-<V>.tgz` from the GitHub Release at its own
version; add `--from <payload-dir|r2c-payload-<V>.tgz>` for an offline install.
A user-scope install uses `~/.r2c/engine/<V>/bin/r2c.js` and `--scope user`.

## Hooks

`session_stop` blocks with `{"decision":"block","reason":…}` and respects
`stop_hook_active`; the shim keeps its own 8-per-`(run_id, step_id)` counter
because a native block does not consume the agent's allowance. `tool_call`
denies writes to `.r2c/runs/**`, `.r2c/usage/**`, `.r2c/latest.json` and
workflow manifests. When the hook cannot resolve a session, delivery is a
no-op; B mode (`r2c next`) is always available.

## Failure modes

- 0-byte or `description`-less skills are never registered; `doctor` reports
  them through `discovery`.
- Hook modules run under embedded Bun and resolve `node` from `PATH` (never
  `process.execPath`); a missing `node` makes the hook a silent no-op.
- User-scope installs do not touch the project tree; project-scope installs do
  not write `~/.omp/agent`.
