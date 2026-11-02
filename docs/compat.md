# Compatibility matrix

Generated from `package.json`, `runtime/r2c/engine/package.json` and the
projection manifests by `node scripts/release.mjs --compat`. Do not edit by
hand: `node scripts/release.mjs --check` fails when this file drifts.

| Dimension | Object | Range |
| --- | --- | --- |
| Framework | `r2c-framework` | `0.1.0` |
| Engine | `r2c-runner` | `0.1.0` |
| Contract | bundle / IR / projection | `r2c.bundle/v1`, `r2c.ir/v1`, `r2c.projection-result/v1` |
| Projection | `agent-native` | `0.1.0` |
| Projection | `r2c` | `0.1.0` |
| Node | `r2c-framework`, `r2c-runner` | `>=22.19.0 <23 \|\| >=24.0.0` |
