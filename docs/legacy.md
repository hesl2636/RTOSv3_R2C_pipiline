# Legacy channel (frozen)

> Historical record. New work must not use the retired mechanisms named here;
> see `docs/install.md` for the forward channel.

Before P6, r2c shipped a lock-step legacy channel: a `v<engine>` Release with
`r2c-engine-<E>.tgz`, `r2c-payload-<E>.tgz`, `install.mjs` and
`SHA256SUMS.txt`, installed by `install.mjs --agent <id> --version <V>`. The
engine discovered a declarative adapter declaration (`adapter.json` +
`map.json`) inside the payload and installed the layout, host commands, hooks
and derived role files itself.

That mechanism is retired:

- the declaration-driven adapter install, `derive-agent`, the four role
  templates and the `r2c.adapter/v1` / `r2c.adapter-map/v1` revisions are gone;
- `r2c adapter ...` and `r2c acceptance ...` no longer exist in the engine;
- main stopped building and publishing `r2c-payload-<E>.tgz` at the cutover.

What still works, and is deliberately frozen:

- published `v<E>` Releases and their frozen `install.mjs` / engine bytes;
- the legacy `.r2c/` layout and `r2c.install/v1` receipts;
- `scripts/install.mjs`'s legacy flags against those old Releases;
- takeover of a legacy install by the bundle installer (`--migrate-legacy`),
  which verifies, backs up, retires the old receipt under
  `.r2c/install/legacy/*.retired` and writes the new identity in one journal.

The replacement for the old zero-model acceptance face is the installer's
`doctor` plus the per-target smoke expectations declared by each target
descriptor.
