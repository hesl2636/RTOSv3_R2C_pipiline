# Repository layout

Single npm package at the root (`hm2b-framework`, private, no workspaces), with
a nested engine package. The dependency direction is
`core → ir → assembler → projection → runtime/*`; `installer/`, `bin/` and
`web/` are composition roots.

```text
.
├── package.json                  # hm2b-framework: framework version, bin: hm2b + hm2b-assembler
├── package-lock.json
├── LICENSE
├── README.md
├── CHANGELOG.md
├── GLOSSARY.md
├── bin/
│   ├── hm2b-assembler.js         # framework CLI: bundle validate | ir validate | compile | project
│   └── assembler/                # one module per command
├── core/                         # pure predicates (no node:*, no third party)
│   ├── canonical-json.js
│   ├── code-point.js
│   ├── diagnostics.js
│   ├── exit-codes.js
│   ├── glob.js
│   ├── paths.js
│   ├── schema.js
│   ├── semver.js
│   └── node/                     # the only Node-only core seam
│       ├── atomic-write.js
│       ├── inflate.js
│       └── sha256.js
├── ir/                           # hm2b.ir/v2 contract (revision, serialize, paths)
├── assembler/                    # bundle → IR: zip reader, validate, compile, limits, checks/assets.js
├── projection/                   # registry, options, project, validate-result
├── runtime/
│   ├── shared/                   # renderRole, constitution, placeholder, submit, YAML writer
│   ├── runner/
│   │   ├── projection/           # runner projection.json + project.js + manifest.js
│   │   ├── contract/             # pure hm2b.workflow/v1 validation (probe injection)
│   │   ├── (revision docs)       # workflow / state / latest / usage
│   │   ├── assets/
│   │   │   ├── commands/         # generic hm2b-*.md host commands
│   │   │   └── hook.mjs          # runtime hook shim
│   │   └── engine/               # hm2b-runner package: bin/hm2b.js + sources
│   └── agent-native/
│       ├── projection/           # one projection, five targets
│       │   ├── projection.json
│       │   ├── project.js
│       │   └── targets/          # <id>.js descriptors
│       └── targets/<id>/assets/  # host integration assets (declared with sha256)
├── installer/                    # install plan execution, receipts, runtime, release install
├── web/                          # zero-build front end (serve.mjs is the only node file)
├── examples/rtosv3/              # bundle/ (editable) + dist/ (committed deterministic zip)
├── scripts/                      # install.mjs, build-bundle.mjs, release.mjs, verify-sums.mjs, lib/
├── test/                         # node --test; mirrors the module tree
└── docs/
```

Notes:

- Module paths, in dependency order: `core/`, `ir/`, `assembler/`,
  `projection/`, `runtime/shared`, `runtime/runner/contract`,
  `runtime/runner/schema`, `runtime/runner/projection`, `runtime/runner/engine`, `runtime/agent-native`,
  `installer/`, `bin/`, `web/`.
- `runtime/runner/engine` is the only package allowed to import `yaml` and the
  only one that may import `node:*` outside `core/node/` and the composition
  roots. Its extracted archive layout is described in
  `scripts/lib/engine-archive.mjs`.
- `runtime/runner/assets` and `runtime/agent-native/targets/*/assets` are
  payload content, not modules: the installer renders them for hosts.
- `web/serve.mjs` is the single Node entry of the front end; the browser
  imports the same `core/`, `ir/`, `assembler/`, `projection/` and
  `runtime/shared/` modules by relative URL.

## Bundle and IR contract (v2)

`hm2b.bundle/v2` describes the bundle zip; `hm2b.ir/v2` describes the compiled
`workflow.ir.json`. The manifest validator in `assembler/validate-bundle.js`
and the checks under `assembler/checks/` are authoritative; the schema
documents next to them are descriptive.

`bundle.json` fields: `schema`, `id`, `name`, `version`, `description`,
`stages`, `roles`, `tasks`, `skills`, `knowledgeBase`, `checklists`, `hooks`,
`mcp`, `constitution`, `requires`.

Archive layout, beside the flow files (`stages/`, `roles/`, `tasks/`,
`skills/`, `constitution/`):

```text
bundle.json
knowledge-base/<group>[/<subgroup>]/<file>.md   # knowledgeBase[]
checklists/<id>.md                              # checklists[]
hooks/hooks.json                                # hooks.path, canonical JSON
mcp.json                                        # mcp.path, canonical JSON + mcpServers object
```

Bundle paths are at most 100 UTF-8 bytes and 4 segments — four segments admit
`knowledge-base/<group>/<subgroup>/<file>.md`. Admission is
declaration-driven: an asset file under `knowledge-base/`, `checklists/`,
`hooks/` or a top-level `mcp.json` that the manifest does not declare is one
`BUNDLE_UNEXPECTED_PATH`; a declared file that is absent is
`BUNDLE_ASSET_FILE_MISSING`. Only `hooks.json` and `mcp.json` have JSON body
rules; both must be canonical JSON, and `mcp.json` must carry an object under
`mcpServers`.

IR fields, in canonical order: `schema`, `id`, `name`, `version`,
`description`, `source`, `requires` (absent when the bundle has none),
`stages`, `roles`, `tasks`, `skills`, `knowledgeBase`, `checklists`, `hooks`,
`mcp`, `constitution`. `knowledgeBase` entries are `{path, body, source}`
sorted by path, `checklists` entries are `{id, body, source}` sorted by id,
and `hooks`/`mcp` are one `{path, body, source}` record or `null`.
`assembler/compile.js` embeds every asset body and its source hash, so the IR
is the only input the projections read; `assembler/validate-ir.js` re-checks
the asset shapes, canonical JSON and sort order.

The projections install the embedded assets: `runner` writes
`knowledge-base/**`, `checklists/**`, `hooks/hooks.json` and `mcp.json` at the
install root (the project root); `agent-native` writes the same relative paths
once under the shared namespace `.agents/agent-native/<bundle-id>/` for all
selected targets. Undeclared assets produce no file.

## Schema documents

The JSON Schema documents sit next to the module that owns the contract. They
are descriptive: the hand-written validators stay authoritative and no schema
runtime dependency is added.

| Document | Owner |
| --- | --- |
| `assembler/schema/bundle.schema.json` | `assembler/validate-bundle.js` |
| `assembler/schema/stage.schema.json` | `assembler/checks/stages.js` |
| `ir/schema/ir.schema.json` | `assembler/validate-ir.js` |
| `projection/schema/options.schema.json` | `projection/options.js` |
| `projection/schema/result.schema.json` | `projection/validate-result.js` |
| `projection/schema/roles.schema.json` | `runtime/shared/render-role.js` |

Every document is canonical JSON, uses the `https://hm2b.runner/schema/` `$id`
family and carries the schema revision it describes as its title.
