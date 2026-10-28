# r2c-runner

Declarative workflow runner for the RTOSv3 R2C pipeline. A workflow is a YAML
manifest (`r2c.workflow/v1`); the runner executes it, tracks state in
`.r2c/` inside the project, and hands the next step to whichever agent you
use (claude code, codex, deepseek harness, omp, opencode) or to you directly.

## Run

```bash
npx r2c-runner <cmd>
```

`npx` is the supported entry point: it always resolves the version the project
pinned, and it does not depend on a globally installed binary name.

## Status

This is the first packaged build. It exposes `--version` and `--help`; the
runner command surface (`run`, `next`, `submit`, `status`, `pause`, `resume`,
`cancel`, `token-usage`, `hook`, `validate`) and the `adapter` / `acceptance`
command groups land in follow-up changes.

## Layout

- `pack/` — workflow content (manifests, task files, skills, commands).
- `adapters/` — per-agent install declarations.
- `plugins/` — frozen intranet-only plugins; not published, not installed by
  default. See `docs/plugins.md`.
- `src/`, `bin/` — the runner itself (the only part published to npm).

See `docs/layout.md` for the full tree and ownership, and `docs/legacy.md` for
the archived yellow-zone tree.

## License

MIT — see `LICENSE`.
