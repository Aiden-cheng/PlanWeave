# Distributed platform and package support matrix

**Matrix id:** `REL-002#B-003`  
**Assembled for tip:** `feat/distributed-collaboration` (post REL-002#B-001 / B-002)  
**Policy:** support cells are declared only from **produced artifacts + executed evidence**. TypeScript compilation alone is not a platform claim. A skipped or unavailable live cell is **not** a pass.

Linked prior checkpoint (live tiers, no secret copy): [distributed-remote-execution-checkpoint.md](./distributed-remote-execution-checkpoint.md) (`RV-CHECKPOINT#B-001`).

---

## 1. Declared runtime policy (from package metadata)

| Component | Package | Version | Engines | Binary | Storage |
| --- | --- | --- | --- | --- | --- |
| Coordinator Server | `@planweave-ai/server` | `0.3.0` | Node `>=22.5` | `planweave-server` | `node:sqlite` (built-in; migrations in `dist/migrations.js`) |
| Agent Host | `@planweave-ai/agent-host` | `0.3.0` | Node `>=22.5` | `planweave-agent-host` | `node:sqlite` |
| Wire protocol package | `@planweave-ai/distributed-protocol` | `0.3.0` | Node `>=22.5` | — | schema-only |
| Human collab contracts | `@planweave-ai/collaboration-contracts` | `0.3.0` | Node `>=22.5` | — | schema-only |
| Runtime (dependency) | `@planweave-ai/runtime` | `0.3.0` | Node `>=22.5` | — | library |
| Monorepo tool | pnpm | `10.32.1` | — | — | lockfile authority |
| Wire protocol literal | `agentHostProtocolVersion` | `1` | — | — | fail-closed on mismatch |

**Native dependency note:** Server and Agent Host do **not** depend on `better-sqlite3` / `sqlite3` / `node-gyp-build`. They require a Node runtime that provides `node:sqlite` (Node 22.5+).

**Package major rule:** server / agent-host / distributed-protocol majors must match before a supported matrix is declared (`PLANWEAVE_COMPATIBILITY_BOUNDS`).

---

## 2. Coordinator / Agent Host install matrix

| OS | Arch | Node | Install method | Contents | Migrations-in-JS | Serve/preflight smoke | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| macOS (Darwin) | arm64 | v26.3.0 | `pnpm pack` → clean `npm install` of tarballs | bins + `dist/` | yes (`schemaVersion=21` on ready) | `planweave-server serve` + `planweave-agent-host preflight` | **verified (this block)** |
| Linux | x64 (ubuntu-latest) | 26 (CI) | monorepo `pnpm install --frozen-lockfile` + build + unit + CLI/core integration | CI builds Server/Host packages; **does not** by itself prove multi-process install | unit/build only for Server/Host until a green distributed integration job exists on tip | **not** a substitute for realProcess / operator walkthrough | **unverified for Server/Host multi-process & consumer tarball** — Ubuntu CI historically ran only `test:unit` + `test:integration:cli` + `test:integration:core` (Runtime/Desktop/MCP). `packages/server` / `packages/agent-host` integration (`realProcess*`, `loadRecoveryMatrix`, `operatorWalkthrough`, `lifecycle`, …) was **not** in those shards. Darwin arm64 realProcess evidence does **not** count as Linux. A `test:integration:distributed` CI shard may be present on tip to *produce* Linux evidence later; until that job is green and recorded here, **do not** claim public Linux Server/Host support. |
| Linux | aarch64 | — | — | — | — | — | **unverified** — do not claim public support until clean tarball install+smoke runs |
| Windows | x64 | 26 (CI platform suite) | monorepo platform tests | limited surface | not a Server install claim | not Server/Host packaged install | **not a Server/Host support cell** |
| Linux container (docker linux/amd64) | x64 | — | clean tarball install | — | — | — | **unverified this block** (Docker daemon unavailable on operator host) |

### Artifact hashes from REL-002#B-003 clean-install smoke (Darwin arm64)

Report: `/tmp/planweave-distributed-install-smoke.json` (`result=passed`, Node v26.3.0, pnpm 10.32.1). Hashes are of local `pnpm pack` tarballs on that run (not published release assets).

| Package | Version | sha256 | bytes |
| --- | --- | --- | --- |
| `@planweave-ai/distributed-protocol` | 0.3.0 | `06d6387fc40e8a34898a68f95f20921a6143412519c39d8a627945c466607e4a` | 37661 |
| `@planweave-ai/collaboration-contracts` | 0.3.0 | `30150b4d646efd784d394a7be1412eab548eb84ab823ba0c2f354f5a3bdb5620` | 32835 |
| `@planweave-ai/runtime` | 0.3.0 | `34bfbc0606caa09932a175c10eecfe6e2a411c131b04612de75851172150387e` | 1100135 |
| `@planweave-ai/server` | 0.3.0 | `5628e05086ef02b90f79db000f96a61802f202ba911132ae50beba19fcb6444b` | 337139 |
| `@planweave-ai/agent-host` | 0.3.0 | `e05064699d21f1de22a1b55caf4969fca52cf82aab34ec7ae77ae86e175959b6` | 102958 |

Serve/preflight observations: `/healthz` 200, `/readyz` `{status:ready,schemaVersion:21}`, `/version` `{serverVersion:0.3.0,protocolVersion:1}`, Host preflight `credential=missing` offline diagnostics only.

### Local clean-install command (authoritative for tarball path)

```bash
pnpm check:distributed-package-install
# or:
node scripts/distributed-package-install-smoke.mjs --report /tmp/distributed-install-smoke.json
```

What the smoke asserts:

1. Pack order: protocol → collaboration-contracts → runtime → server → agent-host  
2. Tarballs rewrite `workspace:*` to concrete versions  
3. Required paths: Server `dist/bin.js` + `dist/migrations.js`; Host `dist/bin.js`  
4. No `.node` native bindings inside Server/Host packages  
5. `node:sqlite` works in the consumer install  
6. `GET /healthz`, `/readyz`, `/version` after `serve`  
7. Host `preflight` succeeds without exposing local paths in diagnostics  
8. `real-acp-smoke --list-profiles` returns the five Host-local ACP profile ids  

Pack helper: `pnpm pack:distributed`.

---

## 3. Desktop matrix (from builder targets + CI)

| Platform | Artifact targets (declared) | Packaged build CI | Packaged startup smoke | Local unsigned build | Support decision |
| --- | --- | --- | --- | --- | --- |
| macOS | dmg, zip (release: universal) | `desktop-smoke.yml` → `verify:packaged:mac` | yes (macOS runner) | `pnpm --dir packages/desktop smoke` (dev) / `verify:packaged:mac` | **supported when CI smoke green** (unsigned local installs may warn) |
| Windows | nsis, zip x64 | `ci.yml` `windows-packaged-smoke` | yes | `pack:win` + `smoke:packaged:win` | **supported when CI smoke green** (unsigned) |
| Linux | AppImage, deb, tar.gz x64 | Desktop Release workflow builds | **no default packaged-start CI cell** | `dist:linux` local possible | **artifact-produced**; packaged-start **not** claimed as verified support without explicit evidence |

Desktop version on tip may differ from npm library `0.3.0` (see `packages/desktop/package.json`). Desktop release path remains the manual GitHub Actions **Desktop Release** workflow.

---

## 4. ACP Agent / profile matrix

Host-local profile ids (Runtime registry + `planweave-agent-host real-acp-smoke --list-profiles`):

| profileId | agentId | verifiedAdapterVersion (informational pin) | Protocol policy |
| --- | --- | --- | --- |
| `codex-acp` | `codex` | from registry launch metadata | Must negotiate ACP SDK protocol (`@agentclientprotocol/sdk` authority); mismatch fail-closed, **no CLI fallback** |
| `claude-code-acp` | `claude-code` | … | same |
| `opencode-acp` | `opencode` | … | same |
| `pi-acp` | `pi` | … | same |
| `grok-acp` | `grok` | … | same |

Protocol rejection coverage:

- `assertAgentHostProtocolCompatible` rejects non-literal wire versions (`packages/distributed-protocol`)  
- ACP engine/elicitation unsupported schema paths fail closed (REL-002#B-001 fixes)  
- Live **execute** compatibility is **not** green on RV-CHECKPOINT (provider/runtime failure); see §5  

---

## 5. Live evidence link (RV-CHECKPOINT — no secrets)

Source: [distributed-remote-execution-checkpoint.md](./distributed-remote-execution-checkpoint.md)

| Tier | Requirement | Checkpoint status | Counts as pass? |
| --- | --- | --- | --- |
| Deterministic multi-process | required for `releaseReady.ci` (release-gate CI tier) | **passed on Darwin arm64** operator re-runs (25/25; REL-002#B-001/B-002). That is **not** a Linux platform support claim. Historical GitHub Actions `cli`/`core` integration shards did **not** execute `packages/server` realProcess suites. | yes for `releaseReady.ci` when evidence is re-run; **not** a public Linux Server/Host support cell |
| Local real ACP | required before supported-version release | **failed / blocked** (`codex-acp` preflight auth ok, execute failed with host ACP process error / provider limit) | **no** |
| Remote authenticated VPS | required pre-release | **blocked / skipped** (no `PLANWEAVE_VPS_E2E_CONFIG` / disposable VPS) | **no** |
| local-tls-fixture e2e | CI-adjacent only | passed with **mock** ACP | **not** a remote-vps pass |

**Release readiness implication:** `supportedVersionRelease=false`, `preRelease=false` until fresh hard-gate REAL_ACP and remote-vps evidence are supplied (14-day evidence TTL). Monorepo unit/build success on Ubuntu alone never promotes REAL_ACP/VPS or Linux multi-process support.

---

## 6. Dependency vulnerability / license metadata

| Check | Tooling | Scope | Result (this block) |
| --- | --- | --- | --- |
| High/critical advisories | CI: `npx pnpm@11.4.0 audit --audit-level=high` | full monorepo graph | reports high findings under **desktop packaging/dev toolchain** (`brace-expansion` via electron-builder/asar; `postcss` via vite) — not in Server/Host production runtime graph |
| Consumer tarball install audit | `npm install` of packed protocol/contracts/runtime/server/host | production install set | **0 vulnerabilities** |
| License | package.json `license` | shippable PlanWeave packages | **MIT** for server, agent-host, protocol, collaboration-contracts, runtime |

Residual monorepo desktop-toolchain highs are tracked as release hygiene risk for Desktop packaging, not as a Server/Host install blocker. Actionable production-path findings must be fixed without unrelated mass upgrades.

---

## 7. Support decision summary

| Surface | Public support claim | Blocker if missing |
| --- | --- | --- |
| Node 22.5+ for Server/Host/CLI libraries | **yes** | engines field + `node:sqlite` |
| Server/Host on macOS arm64 via packed tarballs | **yes** (this block) | re-run `pnpm check:distributed-package-install` after pack changes |
| Server/Host multi-process on Linux x64 (realProcess / operator / load recovery) | **no** — **unverified** | requires green Ubuntu execution of Server/Host multi-process suites (or consumer tarball install+smoke) recorded on tip; monorepo unit/build and CLI/core integration alone are insufficient |
| Server/Host monorepo unit/build on Linux x64 | **compile/unit only** (not a multi-process support claim) | Ubuntu `ubuntu-gate` unit job; does not authorize public “Linux Server/Host supported” wording |
| Server/Host on Linux aarch64 | **no** until verified | remove from any public matrix row |
| Desktop macOS packaged | **yes** when Desktop Smoke CI green | packaged smoke workflow |
| Desktop Windows packaged | **yes** when Windows packaged smoke CI green | CI job |
| Desktop Linux packaged-start | **not claimed** | only artifact build targets unless smoke evidence added |
| ACP profiles listed above | **supported as protocol contracts** | live execute still blocked for supported-version release |
| REAL_ACP hard gate | **not satisfied** | blocks supported-version release |
| remote-vps hard gate | **not satisfied** | blocks pre-release |

Any required cell that remains unsupported or unverified **blocks release** or must be removed from public support claims. This matrix intentionally leaves **Linux Server/Host multi-process (x64 and aarch64)**, Linux aarch64 install, and Desktop Linux packaged-start **out** of the public “supported” set until OS-specific evidence exists.
