# Repository layout

Single npm package at the root (`r2c-framework`, private, no workspaces), with
a nested engine package. The dependency direction is
`core → ir → assembler → projection → runtime/*`; `installer/`, `bin/` and
`web/` are composition roots.

```text
.
├── package.json                  # r2c-framework: framework version, bin: r2c + r2c-assembler
├── package-lock.json
├── LICENSE
├── README.md
├── CHANGELOG.md
├── GLOSSARY.md
├── bin/
│   ├── r2c-assembler.js          # framework CLI: bundle validate | ir validate | compile | project
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
├── ir/                           # r2c.ir/v1 contract (revision, serialize, paths)
├── assembler/                    # bundle → IR: zip reader, validate, compile, limits
├── projection/                   # registry, options, project, validate-result
├── runtime/
│   ├── shared/                   # renderRole, constitution, placeholder, submit, YAML writer
│   ├── r2c/
│   │   ├── projection/           # r2c projection.json + project.js + manifest.js
│   │   ├── contract/             # pure r2c.workflow/v1 validation (probe injection)
│   │   ├── (revision docs)       # workflow / state / latest / usage
│   │   ├── assets/
│   │   │   ├── commands/         # generic r2c-*.md host commands
│   │   │   └── hook.mjs          # runtime hook shim
│   │   └── engine/               # r2c-runner package: bin/r2c.js + sources
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
  `projection/`, `runtime/shared`, `runtime/r2c/contract`,
  `runtime/r2c/schema`, `runtime/r2c/projection`, `runtime/r2c/engine`, `runtime/agent-native`,
  `installer/`, `bin/`, `web/`.
- `runtime/r2c/engine` is the only package allowed to import `yaml` and the
  only one that may import `node:*` outside `core/node/` and the composition
  roots. Its extracted archive layout is described in
  `scripts/lib/engine-archive.mjs`.
- `runtime/r2c/assets` and `runtime/agent-native/targets/*/assets` are
  payload content, not modules: the installer renders them for hosts.
- `web/serve.mjs` is the single Node entry of the front end; the browser
  imports the same `core/`, `ir/`, `assembler/`, `projection/` and
  `runtime/shared/` modules by relative URL.

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

Every document is canonical JSON, uses the `https://r2c.runner/schema/` `$id`
family and carries the schema revision it describes as its title.
