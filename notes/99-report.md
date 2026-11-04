# #99 evidence report: dsh Cordis rows

> Investigation record, not product documentation. It names the retired/legacy
> vocabulary only to explain why the dsh target ships the v1 fallback.

Date: 2026-11-02. Source: a local `deepseek-harness` checkout at commit
`22ddee3792402c3e70ec5f86a63c3e3e895a2f60` (2026-10-23). Every claim below
was read from that checkout; nothing here is inferred from the prototype.

## Findings

### 1. Patch rows are `insert:` lists

`packages/bundle/base/README.md` shows the profile-patch shape:

```yaml
- insert:
    - id: tool-str-replace-editor
      name: '@deepseek-ai/dsh-tool-str-replace-editor'
      config:
        maxOutputChars: 16000
```

An entry is `id:` + `name: '@deepseek-ai/dsh-…'` + `config:`. The
`- insert:` wrapper is the row key — the prototype's `plugin:` key is wrong.

### 2. A preset row is `dsh-agent-preset` with `config.id` + `config.plugins`

`packages/bundle/web-app/presets/standard.patch.yml`:

```yaml
- insert:
    - id: preset-standard
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: standard
        order: 1
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
```

The same shape appears in `minimal.patch.yml`, `ptc.patch.yml` and
`cordis.patch.yml` under the same directory. `id` is the preset identity the
registry keys on; `plugins` is the child row list.

### 3. Persona is a required-`prefix` row

`packages/preset/persona/README.md`:

```yaml
- name: '@deepseek-ai/dsh-persona'
  config:
    prefix: You are a terse systems engineer who answers in short commands.
```

`prefix` is required (`suffix` defaults to `''`, `complete` defaults to
`false`). The row must be mounted inside a preset composition; mounting it
globally collides with the deployment persona registration.

### 4. `allowedAgentPresets` belongs to `dsh-tool-subagent`

`packages/subagent/tool-subagent/README.md` lists the tool config:

| Field | Default | Meaning |
| --- | --- | --- |
| `agentPreset` | — | Default independent child preset id; requires in-process spawn |
| `allowedAgentPresets` | — | Non-empty preset-id allowlist exposed as the model's optional `agent_preset` enum; must include `agentPreset` when both are set |

`docs/config-catalog.md` carries the generated type:
`allowedAgentPresets?: string[] | undefined`. Only in-process spawn supports
these options; fork and external backends reject them.

## Consequence for hm2b v2

The v1 dsh target cannot express a role as a native agent, so it does not emit
preset rows or `allowedAgentPresets` and reports `subagents: unavailable`.
It ships the shared `.agents/skills` tree plus one aggregate role catalogue,
`.dsh/agent-native/<namespace>.roles.md`, which the main session executes by
section.

The runtime's own patch (`runtime/agent-native/targets/dsh/assets/dsh.patch.yml`)
already uses the verified `- insert:` shape with `id` / `name` / `config` and
install-time path substitution. Emitting role presets is a 1.1 contract
change (new role-to-preset mapping in the projection), not a descriptor tweak.
