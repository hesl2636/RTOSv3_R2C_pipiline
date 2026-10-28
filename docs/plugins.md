# Frozen intranet plugins

`plugins/` holds the three yellow-zone capabilities that cannot work in the
blue zone. They are **frozen**: reference material, not a supported install
path.

| Plugin | Path | Yellow-zone role | Blue-zone status |
| --- | --- | --- | --- |
| upload | `plugins/upload/` | Uploads session data + manifest to the intranet viewer (`upload-session.mjs`, `lib/*`), configured by `config.example.json`. | Not published, not installed. The default workflow has no upload stage. |
| analysis | `plugins/analysis/` | Attribution analysis over session logs (`analyze-session.mjs`, `sdoc-js/**`). | Not published, not installed. The default workflow has no analysis stage. |
| intranet-mcp | `plugins/intranet-mcp/servers.json` | Declares the three intranet MCP servers (`sr-fetcher-mcp`, `ar-fetcher-mcp`, `codebase-mcp-server`). | Not published, not merged into any agent's MCP config by the installer. |

## Boundaries

- **Not in npm.** The package `files` whitelist is `bin/`, `src/`, `schema/`,
  `README.md`, `LICENSE`. `plugins/` is excluded and `npm pack` must never
  contain it.
- **Not in the default install.** No `adapter.json`, `map.json` or default
  workflow references `plugins/`. Installing an agent adapter installs the
  engine payload only. Users who want the intranet stages opt in by pointing a
  manifest at the plugin explicitly, on an intranet host.
- **Not part of acceptance.** No L1 check depends on these files; the gates
  are zero-model and zero-secret and run without intranet reachability.
- **Distribution.** Plugins travel as the intranet-only
  `r2c-intranet-plugins` archive; they are never a GitHub Release asset for the
  public `r2c-plugin-V.tgz` payload.

## Sanitization

Tracked copies carry no environment coordinates. Intranet registry addresses,
agent environment variables and the retired per-user state directory were
replaced with placeholders (`LEGACY_NPM_REGISTRY_URL`, `LEGACY_*`,
`.legacy-state`, `*.example.invalid`) so that no blue-zone file resolves to an
intranet host by accident. The original byte-for-byte files are preserved in
the `legacy-yellow-zone` tag and its archive — see `docs/legacy.md`.

The plugins are also not a permanent home: they are retained so intranet
maintainers can diff behaviour when the blue-zone equivalents are designed, and
they may be dropped once that replacement exists.
