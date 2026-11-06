# rtosv3-drvport bundle example

`bundle/` is the editable source form of the sample bundle `rtosv3-drvport@1.0.0`.
`dist/bundle-rtosv3-drvport-v1.0.0.zip` is the committed deterministic build
product, and `FILES.sha256` covers every file in `bundle/`.

## Source and provenance

- Upstream repository: `hesl2636/RTOSv3_R2C_pipline`.
- On 2026-11-02 that repository was unavailable: `gh api repos/hesl2636/RTOSv3_R2C_pipline`
  and `git ls-remote` both returned Not Found, and a public search found no
  repository with that name.
- The sample is therefore vendored from the `pack/` tree of this repository at
  commit `66252455d8d0b9da649f46af1692314dffced948` (`pack@6625245`, from
  before the 2026-11 rename that corrected the *pipeline* spelling). The same
  commit provides 4 tasks, 35 skills and the 4-stage workflow.
- `pack/` is unchanged by this example; `bundle/` is the migrated, bundle-shaped
  copy. If the upstream repository becomes available, re-baseline deliberately
  and bump the bundle version.

## Contents

49 files, one bundle (`r2c.bundle/v1`):

```text
bundle.json
stages/{analysis-design,detailed-design,implementation,verification}.json   # 4 stages, 4 steps
roles/{bys-architect,bys-designer,bys-impl-lead,bys-release-lead}.md        # 4 roles
tasks/{analysis-design,detailed-design,implementation,verification}-orchestration.md
skills/<35 ids>/SKILL.md                                                    # 35 skills
constitution/CONSTITUTION.md                                                # 0 bytes
```

Placeholder inventory: **40** explicit placeholders = 1 constitution
(`placeholder: true` in `bundle.json`, 0-byte file) + 4 roles
(`placeholder: true`, empty instructions) + 35 skills (`placeholder: true`,
visible `> **占位（placeholder）**` banner preserved in the body). Placeholders
still occupy their ids, stay declared in `bundle.json`, and are installed.

The four task files keep their original three sections byte for byte; only
`## 提交` and its single `{{submit}}` code block were appended. Known residual
baseline text is intentionally preserved: `--note placeholder:<id>` in the task
files, `.r2c/ir.md` / `.r2c/sr-map.md` in the analysis-design task, and
`.r2c/artifacts/...` in the verification task. These do not match the runtime
leak diagnostics of decision #67.

Expected validation baseline (spec §17): **0 errors, 2 warnings**
(`BUNDLE_CONSTITUTION_PLACEHOLDER` on `constitution/CONSTITUTION.md`,
`BUNDLE_TASK_RUNTIME_LEAK` on `tasks/analysis-design-orchestration.md`).

## Rebuild

```sh
node scripts/build-bundle.mjs examples/rtosv3/bundle
# or
npm run bundle:build
```

The default output is `examples/rtosv3/dist/bundle-<id>-v<version>.zip`
(derived from `bundle.json`), so the command above writes
`examples/rtosv3/dist/bundle-rtosv3-drvport-v1.0.0.zip`. Use `--out <zip>` to
write elsewhere.

Zip recipe: every regular file under `bundle/` except the optional top-level
`README.md`, sorted by POSIX path byte order; no directory entries; store(0);
general-purpose flags 0; no extra fields; fixed DOS timestamp 1980-01-01
00:00:00 (`time=0`, `date=0x21`); external attributes 0. Entries that cannot be
represented under the bundle path rules (non-POSIX, invalid segment characters,
more than 100 bytes, deeper than 3 segments, symlinks, case-folded collisions)
fail the build.

Expected artifact: **55,042 bytes**, SHA-256
`c22064539aa189b4d9345b1d39b148967a450584badd2593dcf47c0c5b75a13e`.

## `--check`

```sh
node scripts/build-bundle.mjs examples/rtosv3/bundle --check
# or
npm run bundle:check
```

`--check` rebuilds the zip in memory and byte-compares it with the committed
artifact (default path, or `--out <zip>`). It exits 0 on a byte-identical match
and 2 when the artifact is missing or stale. CI runs this so a bundle edit
without a rebuilt zip fails the build.

## `FILES.sha256`

`FILES.sha256` has one `<hex>  <path>` line per bundle file, sorted by path and
relative to `bundle/`. Verify it from the bundle root:

```sh
(cd examples/rtosv3/bundle && sha256sum -c ../FILES.sha256)
```
