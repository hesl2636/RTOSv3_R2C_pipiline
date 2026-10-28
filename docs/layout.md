# Repository layout

One npm package (`r2c-runner`) at the repository root. No workspaces: the
engine, the workflow content and the agent adapters live in one tree but only
the engine is published.

## Target tree

```text
.
├── bin/
│   └── r2c.js                     # thin entry: imports src/cli.js and awaits main
├── src/
│   ├── cli.js                     # argv parsing, --json envelope, exit codes
│   ├── manifest.js                # r2c.workflow/v1 discovery + strict validation
│   ├── state.js                   # runId, state.json, events.jsonl, locks, claim
│   ├── render.js                  # first step / next step / submit line text
│   ├── gate.js                    # expect.outputs + gate[] execution
│   ├── hook.js                    # hook stop / hook pre-tool-use dialects
│   ├── version.js                 # restricted semver evaluator (requires.engine)
│   ├── schema/                    # manifest/schema helpers
│   ├── adapter/                   # the single installer (install/doctor/...)
│   └── acceptance/                # fixture + zero-model aggregator
├── schema/                        # r2c.{workflow,state,latest,usage,adapter,
│                                  #   adapter-map,plugin}/v1 JSON Schemas
├── test/                          # node --test suites (not published)
├── pack/                          # workflow package = manifest root
│   ├── workflows/<name>.yaml
│   ├── tasks/<step-id>.md
│   ├── skills/<id>/SKILL.md
│   └── commands/<id>.md
├── adapters/
│   ├── claude-code/               # adapter.json, map.json, assets/, smoke.mjs
│   ├── codex/
│   ├── dsh/
│   ├── omp/
│   └── opencode/
├── plugins/
│   ├── upload/                    # frozen intranet upload plugin
│   ├── analysis/                  # frozen intranet attribution analysis plugin
│   └── intranet-mcp/              # frozen intranet MCP server definitions
├── scripts/
│   └── release.mjs                # the only packager (r2c-plugin-V.tgz)
├── docs/
│   ├── layout.md                  # this file
│   ├── install.md
│   ├── legacy.md
│   ├── plugins.md
│   ├── compat.md
│   ├── blue-zone/preflight.md
│   └── agents/issue-tracker.md    # preserved as-is
├── .github/workflows/             # ci, acceptance, live, release
├── README.md
├── LICENSE
├── .gitignore
└── package-lock.json
```

## Ownership

| Path | Owner | Rules |
| --- | --- | --- |
| `bin/r2c.js` | engine | Zero logic. One import + `await main(argv)`; everything else lives in `src/`. |
| `src/` | engine | Sole owner of argv parsing, the `--json` envelope, exit codes 0–5, manifest validation, state, gates, hooks, the installer and the acceptance aggregator. |
| `schema/` | engine | `r2c.workflow/v1` is the single source of truth for manifest validation; the other six schemas pin the files the engine writes. Schema revisions are orthogonal to package versions. |
| `test/` | engine | `node --test` only; never published. |
| `pack/` | workflow authors | The only place workflow content exists: manifests, task files, skills, command sources. Adapters must not keep copies of these files. `pack/` is the manifest root (`workflows/` sits directly inside it). |
| `adapters/<agent>/` | agent adapters | Declarations (`adapter.json`, `map.json`), agent-specific assets, optional `steps.mjs` / `smoke.mjs`. Copies of `pack/` content are forbidden; install-time generation only. |
| `plugins/{upload,analysis,intranet-mcp}/` | intranet maintainers | Frozen. Not published to npm and never installed by default. See `docs/plugins.md`. |
| `scripts/release.mjs` | release maintainer | The single packager; produces `r2c-plugin-V.tgz` + `SHA256SUMS.txt`. |
| `docs/` | maintainers | `docs/agents/issue-tracker.md` is preserved unchanged; the remaining docs describe this layout, installation, legacy recovery, plugins, compatibility and blue-zone preflight. |
| `.github/workflows/` | CI maintainers | Zero-secret gates; live agent probes stay manual and `continue-on-error`. |

## What is published

The npm package contains exactly `package.json` plus the `files` whitelist:
`bin/`, `src/`, `schema/`, `README.md`, `LICENSE`. `pack/`, `adapters/`,
`plugins/`, `test/`, `docs/`, `scripts/` and `.github/` are never published —
adapters ship as the separate `r2c-plugin-V.tgz` release asset.

## Runtime state

All run state lands inside the project under `.r2c/`:

| Path | Committed? |
| --- | --- |
| `.r2c/runs/`, `.r2c/latest.json`, `.r2c/usage/` | No — runtime only |
| `.r2c/install/`, `.r2c/plugin/` | No — install receipts and payloads |
| `.r2c/ir.md`, `.r2c/sr-map.md`, `.r2c/artifacts/**` | Yes — business artifacts |

`.gitignore` lists exactly those five runtime paths (plus `node_modules/`).
Local-only patterns belong in `.git/info/exclude`, never in the committed file.
