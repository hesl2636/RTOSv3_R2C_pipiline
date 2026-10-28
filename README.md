# r2c-runner

Declarative workflow runner for the RTOSv3 R2C pipeline. A workflow is a YAML
manifest (`r2c.workflow/v1`); the runner executes it, keeps state in `.r2c/`
inside the project, and hands each step to whichever agent you use (Claude
Code, Codex, DeepSeek Harness, omp, opencode) or to you directly.

## Run

```bash
npx r2c-runner <cmd>
```

`npx r2c-runner <cmd>` is the recommended entry point: it always resolves the
version the project pins and needs no globally installed binary. Every command
in this document and in `docs/` is written that way.

## Quick start

A project runs one workflow manifest placed under `workflows/`. Start a run,
do the step, submit it with the line the runner printed, then inspect the run:

```bash
cd my-project
npx r2c-runner run
# ... do the step printed above, then run the printed Submit line, e.g.
npx r2c-runner submit --session-id <session-id> --step <step-id>
npx r2c-runner status
```

- `run` mints a session id when none is given, activates the first step and
  prints the full step text plus an executable Submit line. Nothing else may
  advance the run.
- `submit` re-checks `expect.outputs` and every `gate` command before it
  completes the step; a missing output or a failing gate exits `3` and leaves
  the step active.
- `status` shows the run, stage, step and next action for the current session
  (or for `latest.json` when the command is read-only).

If the manifest lives outside `workflows/` — for example the copy installed
with an adapter payload — pass it explicitly:

```bash
npx r2c-runner run --manifest .r2c/plugin/0.1.0/workflows/RTOSv3_R2C_pipiline.yaml
```

The Submit line uses the runner command captured at install time or passed with
`--runner-cmd`. To keep it in the same form as this document:

```bash
npx r2c-runner run --runner-cmd "npx r2c-runner"
```

## Install an agent adapter

Adapters are declarative: the engine installer performs every write, so all
five share one code path. Install into the current project from a payload
directory or the release archive:

```bash
npx r2c-runner adapter install claude-code --from <payload-dir|r2c-plugin-0.1.0.tgz> --project .
npx r2c-runner adapter install codex       --from <payload-dir|r2c-plugin-0.1.0.tgz> --project .
npx r2c-runner adapter install dsh         --from <payload-dir|r2c-plugin-0.1.0.tgz> --project .
npx r2c-runner adapter install omp         --from <payload-dir|r2c-plugin-0.1.0.tgz> --project .
npx r2c-runner adapter install opencode    --from <payload-dir|r2c-plugin-0.1.0.tgz> --project .
```

Then check the install without a model call, and remove it when done:

```bash
npx r2c-runner adapter doctor <agent> --project .
npx r2c-runner adapter uninstall <agent> --project .
```

`docs/install.md` covers detection, scopes and paths, `--from`, doctor, upgrade,
rollback and uninstall. Per-agent landing paths are in
`adapters/<agent>/README.md`.

## Stepping modes

The runner defines four ways a finished turn turns into "here is the next step".
The text is identical in all four; only the trigger and the envelope differ.

| Mode | Trigger | Agents | Hand-off |
| --- | --- | --- | --- |
| **A** | Stop / turn-stopping hook, same turn | Claude Code, Codex (after `/hooks` trust), DeepSeek Harness, omp | block/steer payload with the next step |
| **A′** | `session.idle`, new turn | opencode V1 | injected user turn with the next step |
| **B** | No hook fired (untrusted, absent, capped) | any installed adapter | run the printed `next` line yourself |
| **C** | No adapter installed | none | `status` / `next` / `submit` by hand |

**B and C have no runtime guard.** Nothing blocks the model from writing
`.r2c/runs/**`, `.r2c/usage/**`, `.r2c/latest.json` or a workflow manifest when
the adapter is not enforcing the pre-tool-use hook. Only an A/A′ install wires
that guard; under B/C those paths are protected by convention, not by the
runner. The same applies to any host that never receives the hook (for example
Codex before `/hooks` trust): use `submit` and let `expect`/`gate` decide
completion.

## State layout

Everything the runner owns lives under `.r2c/` in the project root:

```text
.r2c/
├── latest.json                 # run routing per session (runtime)
├── runs/<runId>/               # state.json, events.jsonl, workflow.yaml, .lock
├── usage/<runId>.jsonl         # token usage snapshots (runtime)
├── install/<agent>.json        # install receipts (runtime)
├── plugin/<version>/           # installed payload (runtime)
├── ir.md, sr-map.md            # business artifacts (commit these)
└── artifacts/                  # business artifacts (commit these)
```

`.r2c/runs/`, `.r2c/latest.json`, `.r2c/usage/`, `.r2c/install/` and
`.r2c/plugin/` are runtime state and belong in `.gitignore`; the artifacts
under `.r2c/ir.md`, `.r2c/sr-map.md` and `.r2c/artifacts/**` are meant to be
committed. See `docs/layout.md` for the repository tree and ownership.

## Documentation

- [docs/install.md](docs/install.md) — install, payload `--from`, doctor,
  upgrade, rollback, uninstall, per-scope paths, B/C guard warning.
- [docs/compat.md](docs/compat.md) — engine, payload and adapter version matrix
  (generated from the five `adapter.json` files).
- [docs/layout.md](docs/layout.md) — repository tree, ownership, what npm
  publishes.
- [docs/plugins.md](docs/plugins.md) — the frozen optional plugins that are
  never installed by default.
- [docs/legacy.md](docs/legacy.md) — recovery of the archived pre-migration
  tree.
- [docs/blue-zone/preflight.md](docs/blue-zone/preflight.md) — the 47-row
  environment checklist.
- [adapters/<agent>/README.md](adapters/claude-code/README.md) — per-agent
  landing paths and hook wiring (one `README.md` per adapter directory).

## Requirements

Node `>=22.19.0 <23 || >=24.0.0`. The engine has one runtime dependency
(`yaml`); adapters are installed by the engine, not by a package manager.

## License

MIT — see `LICENSE`.
