# Compatibility matrix

Generated from `package.json`, `runtime/runner/engine/package.json` and the
projection manifests by `node scripts/release.mjs --compat`. Do not edit by
hand: `node scripts/release.mjs --check` fails when this file drifts.

| Dimension | Object | Range |
| --- | --- | --- |
| Framework | `hm2b-framework` | `0.1.0` |
| Engine | `hm2b-runner` | `0.1.0` |
| Contract | bundle / IR / projection | `hm2b.bundle/v2`, `hm2b.ir/v2`, `hm2b.projection-result/v1` |
| Projection | `agent-native` | `0.1.0` |
| Projection | `runner` | `0.1.0` |
| Node | `hm2b-framework`, `hm2b-runner` | `>=22.19.0 <23 \|\| >=24.0.0` |
