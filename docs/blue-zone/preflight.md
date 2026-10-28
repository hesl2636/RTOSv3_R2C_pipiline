# Blue-zone preflight

Environment evidence for the 47 checks in spec #17 §8 (skeleton: issue #12).
Verdict vocabulary: `pass`, `fail`, `risk`, `HITL`, `unverified`.

**Method.** Every row marked `T36Docs` was executed on this host on
2026-10-28 between 13:44Z and 13:52Z (Git Bash 3.6.10, Windows_NT 10.0.26300,
x64, user `wuheng`, repository worktree `r2c-wt/36`). Rows marked `carried` were
not re-run in this pass: GitHub authenticated endpoints need a token that this
pass did not have, so the previously captured payload (`.scratch/deps/36.json`,
same repo, same day) and the 2026-10-28 #12 baseline are quoted and labelled
`[carried]`. Output cells are trimmed: runs of whitespace are collapsed,
`exit=<n>` is the command's exit code, and `&#124;` is a literal pipe character.

HITL means the row cannot be completed by this automated pass and needs a
human: npm login/OTP, an irreversible repository visibility change, the Codex
`/hooks` trust prompt, an agent CLI install, or a registry change that needs
administrator rights. The full blocker list is at the end.

## A. npm identity, package and publish (A1–A14)

| ID | Date | Command | Output (trimmed) | Verdict | Executor |
| --- | --- | --- | --- | --- | --- |
| A1 | 2026-10-28 | `npm whoami` | `npm error code ENEEDAUTH / need auth This command requires you to be logged in / exit=1` | HITL | T36Docs (blocked); HITL: maintainer |
| A2 | 2026-10-28 | `npm profile get --json` | `npm error code E401 / 401 Unauthorized - GET https://registry.npmjs.org/-/npm/v1/user / exit=1` | HITL | T36Docs (blocked); HITL: maintainer |
| A3 | 2026-10-28 | `npm org ls hesl2636` | `npm error code E404 / 404 Not Found - GET https://registry.npmjs.org/-/org/hesl2636/user - Scope not found / exit=1` | HITL | T36Docs (blocked); HITL: maintainer |
| A4 | 2026-10-28 | `curl -s -o NUL -w '%{http_code}' https://registry.npmjs.org/r2c-runner` (calibration: `.../yazl`) | `r2c-runner 404 (available); yazl 200 (occupied, probe sound); exit=0` | pass | T36Docs |
| A5 | 2026-10-28 | `node -e "const n=require('./package.json').name;console.log(n, /^[a-z0-9][a-z0-9._-]*$/.test(n), n.length<=214)"` | `r2c-runner true true` | pass | T36Docs |
| A6 | 2026-10-28 | `node -e "console.log(require('./package.json').private)"` | `undefined` | pass | T36Docs |
| A7 | 2026-10-28 | `node -e "console.log(JSON.stringify(require('./package.json').publishConfig))"` | `undefined` — package is unscoped, so `access: public` is not required for the first publish | pass | T36Docs |
| A8 | 2026-10-28 | `npm ping; ls -a .npmrc; ls -a "$USERPROFILE/.npmrc"; grep -n registry package.json package-lock.json` | `PONG 1652ms; no .npmrc in repo or home; package.json has no registry key; lockfile resolves https://registry.npmjs.org/yaml/-/yaml-2.9.1.tgz` | pass | T36Docs |
| A9 | 2026-10-28 | `npm pack --dry-run --json` | `52 files; roots LICENSE, README.md, bin/, package.json, schema/, src/; no docs/, pack/, adapters/, test/, scripts/, .github/, plugins/` | pass | T36Docs |
| A10 | 2026-10-28 | `npm view @anthropic-ai/claude-code engines.node; npm view @openai/codex engines.node; node -v` | `claude >=22.0.0; codex >=16; node v24.22.1; repo declares >=22.19.0 <23 &#124;&#124; >=24.0.0 (strictest, satisfied)` | pass | T36Docs |
| A11 | 2026-10-28 | `npm publish --dry-run` | `r2c-runner@0.1.0, 52 files, package size 92.7 kB, exit=0; npm warn: requires login (dry-run); no E403/E402` | HITL | T36Docs (blocked); HITL: maintainer |
| A12 | 2026-10-28 | `curl -s -o NUL -w '%{http_code}' https://registry.npmjs.org/r2c-runner` | `404` — no package exists, so npmjs has no package Settings page to bind a trusted publisher; first publish must be manual OTP | HITL | T36Docs (blocked); HITL: maintainer |
| A13 | 2026-10-28 | `(no CLI) npmjs package Settings → Trusted publishing` | `not configurable before the first publish; provenance is unsupported for private source repositories; a new trusted publisher expires after 2 days without a successful publish` | HITL | HITL: maintainer |
| A14 | 2026-10-28 | `(no CLI) npmjs package Settings → Publishing access` | `not reachable before A1/A13; policy to choose: Require two-factor authentication and disallow tokens (OIDC publishing is unaffected)` | HITL | HITL: maintainer |

## B. GitHub repository, Actions and Release (B1–B12)

| ID | Date | Command | Output (trimmed) | Verdict | Executor |
| --- | --- | --- | --- | --- | --- |
| B1 | 2026-10-28 | `curl -s -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" https://api.github.com/repos/hesl2636/RTOSv3_R2C_pipiline` | `[carried] permissions admin=true maintain=true push=true; anonymous probe of the same URL returns 404 (private repo)` | pass | carried: .scratch/deps/36.json, main checkout (#12) |
| B2 | 2026-10-28 | `curl -s -H "Authorization: Bearer $TOKEN" .../repos/hesl2636/RTOSv3_R2C_pipiline` | `[carried] private=true, visibility=private, owner hesl2636 (type User); anonymous probe returns 404` | HITL | carried: .scratch/deps/36.json, main checkout (#12); HITL: maintainer |
| B3 | 2026-10-28 | `curl -s -o NUL -w '%{http_code}' -L https://github.com/hesl2636/RTOSv3_R2C_pipiline/releases/download/v0.1.0/r2c-plugin-0.1.0.tgz` | `404` — private repository hides Release assets from anonymous clients; installs use `--from` until the repository is public | HITL | T36Docs (blocked); HITL: maintainer |
| B4 | 2026-10-28 | `curl -s -H "Authorization: Bearer $TOKEN" .../actions/permissions` | `[carried] enabled=true, allowed_actions=all; anonymous probe returns 401` | pass | carried: #12 baseline |
| B5 | 2026-10-28 | `curl -s -H "Authorization: Bearer $TOKEN" .../actions/permissions/workflow` | `[carried] default_workflow_permissions=read; the release workflow must declare permissions: contents: write, id-token: write; anonymous probe returns 401` | pass | carried: #12 baseline |
| B6 | 2026-10-28 | `curl -s -H "Authorization: Bearer $TOKEN" .../actions/runs` | `[carried] 0 workflow runs; Free private allowance is 2000 minutes/month, far above one publish + Release job; anonymous probe returns 404` | pass | carried: #12 baseline |
| B7 | 2026-10-28 | `curl -s -H "Authorization: Bearer $TOKEN" .../actions/secrets` | `[carried] total_count=0 (OIDC path preserves zero secrets); anonymous probe returns 401` | pass | carried: #12 baseline |
| B8 | 2026-10-28 | `curl -s -H "Authorization: Bearer $TOKEN" .../repos/hesl2636/RTOSv3_R2C_pipiline/rulesets` | `[carried] HTTP 403 Upgrade to GitHub Pro or make this repository public; anonymous probe returns 404; no tag rule can be created yet` | HITL | carried: #12 baseline; HITL: maintainer |
| B9 | 2026-10-28 | `curl -s -H "Authorization: Bearer $TOKEN" .../branches/main/protection` | `[carried] HTTP 403 Upgrade to GitHub Pro or make this repository public; anonymous probe returns 401; release gating relies on convention until then` | HITL | carried: #12 baseline; HITL: maintainer |
| B10 | 2026-10-28 | `ls -1 .github/workflows` | `acceptance.yml / ci.yml / live.yml / release.yml (exit=0)` | pass | T36Docs |
| B11 | 2026-10-28 | `curl -s -H "Authorization: Bearer $TOKEN" https://api.github.com/user/orgs` | `[carried] empty; owner is permanently the personal account hesl2636; anonymous probe returns 401` | pass | carried: #12 baseline |
| B12 | 2026-10-28 | `node scripts/release.mjs --out <tmpdir>; sha256sum -c SHA256SUMS.txt` | `r2c-plugin-0.1.0.tgz + SHA256SUMS.txt written; r2c-plugin-0.1.0.tgz: OK; sha256sum (GNU coreutils) 8.32` | pass | T36Docs |

## C. Agent availability and install surface (C1–C15)

| ID | Date | Command | Output (trimmed) | Verdict | Executor |
| --- | --- | --- | --- | --- | --- |
| C1 | 2026-10-28 | `npm view @anthropic-ai/claude-code version engines.node; curl -s -o NUL -w '%{http_code} %{redirect_url}' -I https://claude.ai/install.ps1` | `2.1.312, engines.node >=22.0.0; install.ps1 → 302 https://claude.com/app-unavailable-in-region (region-blocked, npm route only)` | pass | T36Docs |
| C2 | 2026-10-28 | `where claude; test -w "$USERPROFILE/.claude"` | `claude not found (exit=1); ~/.claude missing; no ~/.claude.json` | HITL | T36Docs (blocked); HITL: maintainer |
| C3 | 2026-10-28 | `claude --version; claude -p "ok" --output-format json; claude plugin list` | `claude: command not found (exit=127)` — blocked by C2 | HITL | T36Docs (blocked); HITL: maintainer |
| C4 | 2026-10-28 | `npm view @openai/codex version engines.node` | `0.165.0, engines.node >=16` | pass | T36Docs |
| C5 | 2026-10-28 | `where codex; test -w "$USERPROFILE/.codex"` | `codex not on PATH (exit=1); ~/.codex exists and is writable; desktop-app codex.exe present under AppData but not on PATH` | HITL | T36Docs (blocked); HITL: maintainer |
| C6 | 2026-10-28 | `codex --version; codex exec --json "ok"` | `codex: command not found (exit=127)` — blocked by C5; `/hooks` trust has no programmatic probe | HITL | T36Docs (blocked); HITL: maintainer |
| C7 | 2026-10-28 | `npm view @deepseek-ai/dsh version; npm view @deepseek-ai/dsh dist-tags --json; npm view @deepseek-ai/dsh engines --json` | `latest=0.2.1-rc.2; dist-tags alpha=0.2.2-alpha.2, latest=0.2.1-rc.2, next=0.2.1-rc.4; engines: absent (package declares none)` | pass | T36Docs |
| C8 | 2026-10-28 | `where dsh; test -w "$USERPROFILE/.dsh"; ls "$USERPROFILE/.dsh"` | `dsh not on PATH (exit=1); ~/.dsh writable; contains profiles/ sessions/ storages/` | HITL | T36Docs (blocked); HITL: maintainer |
| C9 | 2026-10-28 | `dsh -V; dsh --profile headless --json "ok"` | `dsh: command not found (exit=127)` — blocked by C8 | HITL | T36Docs (blocked); HITL: maintainer |
| C10 | 2026-10-28 | `curl -s -o NUL -w '%{http_code}' -L https://omp.sh/install.ps1; curl -s -o NUL -w '%{http_code}' -L https://omp.sh/install; npm view @oh-my-pi/pi-coding-agent version engines bin --json` | `install.ps1 200; install 200; 18.13.3, engines.bun >=1.4.4, bin omp → dist/cli.js (Bun-only npm package)` | pass | T36Docs |
| C11 | 2026-10-28 | `where omp; omp --version; test -w "$USERPROFILE/.omp/plugins"` | `C:\Users\wuheng\AppData\Local\omp\omp.exe; omp/18.13.2; ~/.omp/plugins writable (exit=0)` | pass | T36Docs |
| C12 | 2026-10-28 | `omp --version; omp -p "ok" --mode json --no-session; omp plugin list --json; omp skill list --json` | `omp/18.13.2; JSON event stream session/agent_start/turn_start/message_start…, exit=0; plugin list {"npm":[],"marketplace":[]} (r2c adapter not installed); skill list returns registered user skills` | pass | T36Docs |
| C13 | 2026-10-28 | `npm view opencode-ai version os cpu --json; npm view @opencode/cli version os cpu --json` | `V1 1.19.5 (os darwin/linux/win32, cpu arm64/x64); V2 2.2.0 (same os/cpu); V1 is the selected baseline` | pass | T36Docs |
| C14 | 2026-10-28 | `where opencode; ls -d "$USERPROFILE/.config/opencode"` | `opencode not found (exit=1); ~/.config/opencode missing; the parent ~/.config is absent or not writable (test -w fails)` | HITL | T36Docs (blocked); HITL: maintainer |
| C15 | 2026-10-28 | `opencode --version; opencode run "ok"; opencode run --command r2c-status` | `opencode: command not found (exit=127)` — blocked by C14 | HITL | T36Docs (blocked); HITL: maintainer |

## D. Machine (D1–D6)

| ID | Date | Command | Output (trimmed) | Verdict | Executor |
| --- | --- | --- | --- | --- | --- |
| D1 | 2026-10-28 | `node -v; node -p "JSON.stringify(process.versions)"` | `v24.22.1; modules 137, v8 13.6.233.17-node.58, openssl 3.5.9, sqlite 3.53.4` | pass | T36Docs |
| D2 | 2026-10-28 | `npm -v; pnpm -v; npx -v; corepack --version` | `11.19.1 / 11.28.5 / 11.19.1 / 0.36.0` | pass | T36Docs |
| D3 | 2026-10-28 | `where node npm pnpm omp codex claude opencode dsh` | `node/npm/pnpm → AppData\Local\Programs\nodejs; omp → AppData\Local\omp\omp.exe; codex, claude, opencode, dsh not found` | risk | T36Docs |
| D4 | 2026-10-28 | `npm config get registry; npm config get proxy; npm config get https-proxy; npm config get strict-ssl` | `https://registry.npmjs.org/ / null / null / true; no .npmrc anywhere, so these are npm defaults; git has its own proxy http://127.0.0.1:9674 for github.com only` | pass | T36Docs |
| D5 | 2026-10-28 | `for d in .claude .codex .dsh .omp .config/opencode; do if test -w "$USERPROFILE/$d"; then echo "$d writable"; else echo "$d missing-or-readonly"; fi; done; npm config get cache; npm config get prefix` | `.codex/.dsh/.omp writable; .claude and .config/opencode missing; cache C:\Users\wuheng\AppData\Local\npm-cache; prefix C:\Users\wuheng\AppData\Local\Programs\nodejs (user-owned, no elevation)` | pass | T36Docs |
| D6 | 2026-10-28 | `df -h /c; powershell -NoProfile -Command "(Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled).LongPathsEnabled"; powershell -NoProfile -Command '$PSVersionTable.PSVersion.ToString()'; git --version` | `774G available; LongPathsEnabled=0; PowerShell 5.1.26100.9711; git 2.56.0.windows.3; curl/tar/unzip/sha256sum/winget present; bun absent` | risk | T36Docs |

## HITL blockers

19 rows cannot be completed without a human. In dependency order:

1. **npm identity (A1, A2, A3, A11, A12)** — `npm whoami` fails with `ENEEDAUTH`;
   there is no `~/.npmrc` and no token on disk. A human must run `npm login`
   (browser + OTP), then record `npm whoami`, the `tfa` field from
   `npm profile get --json`, and `npm org ls <scope>`. A3 also shows no scope
   exists yet, so the scope decision (`hesl2636` or a new org) is pending.
   A11/A12 depend on A1: first publish must be a manual OTP publish.
2. **npm provenance and access policy (A13, A14)** — both live only in the
   npmjs package Settings UI and only after the package exists; provenance is
   also unsupported while the source repository is private.
3. **Repository visibility (B2)** — flipping private → public is irreversible
   and is the user's decision. It unlocks B3 (anonymous Release download),
   B8 (tag rulesets), B9 (branch protection) and A13 (provenance).
4. **Tag and branch protection (B8, B9)** — both currently return
   `403 Upgrade to GitHub Pro or make this repository public`; nothing has been
   enabled or modified.
5. **Codex `/hooks` trust (C6)** — the trust prompt has no programmatic probe
   and this repository is not in `~/.codex`'s trusted-project list. Installing
   the Codex CLI is also a human step (C5).
6. **Agent CLIs (C2, C3, C5, C6, C8, C9, C14, C15)** — only `omp` 18.13.2 is
   installed. `claude`, `codex` (CLI), `dsh` (CLI) and `opencode` are absent;
   installing them is explicitly outside this pass. Each pair stays HITL until
   the CLI exists, even though the registry and `~/.<agent>` preconditions have
   been probed.
7. **Repository-only check (B3)** — the anonymous download of
   `r2c-plugin-0.1.0.tgz` returns 404. Installs must use `--from <dir|tgz>`
   until the repository is public.

Two non-HITL risks are carried for the release checklist rather than blocking:
`LongPathsEnabled=0` (D6) can break deep npm global trees, and `~/.claude` /
`~/.config/opencode` do not exist yet (D5), so their first-run creation is part
of the agent install, not a preflight failure.
