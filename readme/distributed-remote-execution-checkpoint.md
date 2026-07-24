# Distributed remote execution evidence checkpoint

**Checkpoint id:** `RV-CHECKPOINT#B-001`  
**Assembled at (UTC):** `2026-07-24T05:16:41Z`  
**Branch tip:** `feat/distributed-collaboration` @ `d07e9338842036b08d883fcfb86a0ba9fb296ea6`  
**Verdict:** **Ready for deterministic CI; blocked for supported-version release and pre-release.**

This document correlates RV-001 / RV-002 / RV-003 deliverables with a re-run of the release-gate tiers on the same monorepo tip. It does **not** invent or relabel live evidence. Unavailable required live conditions are recorded as **blocked / not passed**.

Secrets, private keys, enrollment codes, operator bearer tokens, disposable VPS hostnames, and home-directory paths are omitted. Digests, non-secret component versions, and sanitized commands are retained for verifiability.

---

## 1. Component versions (correlated)

| Component | Package | Version | Wire / notes |
| --- | --- | --- | --- |
| Coordinator Server | `@planweave-ai/server` | `0.3.0` | package major must match Host / protocol |
| Agent Host | `@planweave-ai/agent-host` | `0.3.0` | same major as Server |
| Distributed protocol (npm package) | `@planweave-ai/distributed-protocol` | `0.3.0` | same major as Server/Host |
| Agent Host wire protocol | `agentHostProtocolVersion` | `1` | sole supported literal |
| Runtime | `@planweave-ai/runtime` | `0.3.0` | authoritative claim / submit / writeback |
| CLI | `@planweave-ai/cli` | `0.3.0` | thin wrapper (not remote path under test) |
| Node (checkpoint host) | — | `v26.3.0` | `engines.node >= 22.5` |
| pnpm | — | `10.32.1` | monorepo tool |
| OS (checkpoint host) | Darwin arm64 | kernel 25.5.0 | local operator machine, not a VPS claim |

Compatibility policy (from `PLANWEAVE_COMPATIBILITY_BOUNDS`):

- package majors for server / agent-host / distributed-protocol must match
- graceful package downgrade: same-major only after state backup
- no database reset; no silent re-run of interrupted Blocks
- Host replace requires credential revoke

Release-gate package major check on this tip: **ok**. Protocol check: **ok**.

---

## 2. Upstream task map (evidence sources)

| Task | Blocks | Review | Gate-closing commits (subject) |
| --- | --- | --- | --- |
| **RV-001** Production composition, packaging, operator flow | B-001 composition; B-002 production lifecycle / pack; B-003 docs + walkthrough | R-001: REV-001 `needs_changes` (package boundary) → FE-007 resolved → REV-002 **passed** | `ea77cfca` composition; `dd7ad4b0` operator docs; `b5ef1833` spawn Host bin for walkthrough |
| **RV-002** Deterministic multi-process coverage | B-001 real-process harness; B-002 remote Block lifecycle; B-003 crash/replay + auth matrices | R-001 **passed** | `04d4478c` harness; `02d28c69` lifecycle; `5f4d9272` matrices; `e872d828` suite registration |
| **RV-003** Live opt-in paths + release gate | B-001 real ACP smoke; B-002 VPS/TLS e2e; B-003 release gate + rollback | R-001 **passed** (explicit residual risk) | `52ebf3b6` real ACP; `0517fd14` VPS e2e; `d07e9338` release gate |

### Upstream report digests (`shasum -a 256`, assembly 2026-07-24)

Paths are relative to the PlanWeave canvas `results/` tree (not committed to this repo).

| Artifact | sha256 |
| --- | --- |
| `RV-001/blocks/B-001/runs/RUN-001/report.md` | `7c5f1aaa91bfefc30d13f4d3bff0479c10a43be9ad836ef978ac7f5312494302` |
| `RV-001/blocks/B-002/runs/RUN-001/report.md` | `3dc967dae89d6ad3c63fb3247511c180b326681c9c6606b3cf5a99dffa153feb` |
| `RV-001/blocks/B-003/runs/RUN-001/report.md` | `f2424cba2a889c54f13099900989408d7cee355055291e2166e150fc1305fb67` |
| `RV-001/reviews/R-001/attempts/REV-001/review-result.json` | `9ec864ca06d2695363bf9c02b7a61eca294164593811d82dda9e7b6e5208241d` |
| `RV-001/reviews/R-001/attempts/REV-002/review-result.json` | `fba3d827983e83da9cf629df62d0ea6477786b8fdb503f0d9ff52927bb9f9c9d` |
| `RV-002/blocks/B-001/runs/RUN-001/report.md` | `5ffe3ba7c3777b6fc18c78312fa8e67ee06f509c1a6e420c9623936a94610f29` |
| `RV-002/blocks/B-002/runs/RUN-001/report.md` | `46c39c15c18b625880c3cf06addbc11aebafe32b02d0d4b800024f83f0d9c18c` |
| `RV-002/blocks/B-003/runs/RUN-001/report.md` | `64199fc7530a439d663bd065647431cb4a40ec77d5de43762f402b1b10268096` |
| `RV-002/reviews/R-001/attempts/REV-001/review-result.json` | `80ba26025f933ebc2091acfb5ea7e33e126c5b37f8bb65196ce8c58720e593bf` |
| `RV-003/blocks/B-001/runs/RUN-001/report.md` | `1c4dddd5260e9c517accf18ebf1e91ec7c9c69d898a3edfd4f04b2180daf1cf1` |
| `RV-003/blocks/B-002/runs/RUN-001/report.md` | `36b92f6e643efc78470dbf4b399002fdc20beb1c776cf04b595d8bf8346bcfe9` |
| `RV-003/blocks/B-003/runs/RUN-001/report.md` | `c1964f38866814197d85bdd5a96f42cea5c39c1dbfe296fe98ae412b7a3447fa` |
| `RV-003/reviews/R-001/attempts/REV-001/review-result.json` | `61c98dcf7d482e4f863000f68fa6d69330485977160b938b62deba194a32cace` |

---

## 3. Package / install / operator evidence

### What RV-001 proved (not re-published here)

- Production composition root binds Runtime, SQLite services, operator HTTP, Host WSS, artifact materialization; single cleanup path.
- Server `serve` binary, TLS-by-default, loopback-only insecure development, readiness admission, bounded shutdown.
- Agent Host system+custom CA trust; rejects globally disabled TLS verification.
- Operator walkthrough automation (`operatorWalkthrough.test.ts`) exercises public bins only after FE-007 (no Server→Host source import).
- Docs: README **Distributed Operator Guide** + ZH twin — placeholders only.
- Package boundary check `pnpm check:distributed-package-boundaries` green after FE-007.
- Prior `pnpm pack` inspection of Server/Agent Host (bins, migrations-in-JS, metadata) recorded in RV-001#B-002; sample Host tarball on assembly host: `/tmp/planweave-ai-agent-host-0.3.0.tgz` sha256 `2994182b55bcc252e5167984be3b98295e2ee21386bd0d011701f9ef287ee90e` (historical local pack, not a release artifact claim).

### Operator surfaces (stable)

**Server:** `planweave-server serve --config <abs>` (or `PLANWEAVE_SERVER_CONFIG`)  
**Host:** `planweave-agent-host preflight|enroll|status|run|revoke --config <abs>`  
**Probes:** `GET /healthz`, `/readyz`, `/version`  
**Operator API:** host enrollments/list/get/revoke; remote-operations create/get/actions/events/interactions/respond  

Provider/Git credentials stay on Host. Remote execution is ACP-only.

---

## 4. Deterministic process scenarios (CI tier) — **PASSED (re-run)**

**Suite (release-gate CI set):**

```text
pnpm exec vitest run \
  packages/server/src/__tests__/realProcessAcpHarness.test.ts \
  packages/server/src/__tests__/realProcessRemoteBlockLifecycle.test.ts \
  packages/server/src/__tests__/realProcessCrashReplayMatrix.test.ts \
  packages/server/src/__tests__/realProcessAuthorizationMatrix.test.ts
```

**Re-run on checkpoint tip:** 4 files, **25/25 passed**, duration ~45s (first re-run); evidence writer re-run: **25/25**, `exitCode=0`, `generatedAt=2026-07-24T05:16:16.151Z`.

**Environment for suite:** built `packages/server/dist/bin.js` + `packages/agent-host/dist/bin.js`; fake ACP `acpMockAgent.mjs`; loopback insecure/dev or harness configs; **no** `PLANWEAVE_REAL_ACP*` / `PLANWEAVE_VPS_E2E*` gates.

### Scenario → invariant matrix (condensed)

#### A. Harness (`realProcessAcpHarness`)

| Scenario | Invariant |
| --- | --- |
| Clean startup + public enroll | Server ready + Host online via public API |
| Failed Server startup | Timeout diagnostics; logs redacted |
| ACP barrier pause/resume | No production debug endpoints; JSON-RPC completes after resume |
| Restart Server/Host | Durable enrollment preserved; `lastSeenAt` refreshes |
| Kill/close/corrupt/clock controls | Explicit faults; clock injection unsupported on real bins |
| Dispose cleanup | Children terminated; only harness-owned temp roots removed |

#### B. Remote Block lifecycle (`realProcessRemoteBlockLifecycle`)

| Scenario | Invariant |
| --- | --- |
| Success path | Dispatch→ACP→Runtime `terminalReceipt.outcome=completed`; identity fidelity (operation/dispatch/attempt/lease/host) |
| ACP refusal | Terminal failed; Runtime blocked `remote_execution_failed`; no false success |
| Protocol error | `result_json=null`; Runtime not completed |
| User cancel at barrier | `state=cancelled`; Runtime `execution_cancelled`; same identities |
| Permission interaction | Settle `allow_once` → complete with identity fidelity |
| Artifacts + dependency summaries | Envelope carries inputs/summaries; report artifact linked |
| Event disconnect/replay | Events durable after Host restart; cursor after high watermark empty |
| Two Hosts / capability | Incompatible Host awaits; compatible Host terminals only |
| Local without Server | claim+submit still works (local path intact) |

#### C. Crash / replay matrix (`realProcessCrashReplayMatrix` + in-process coordinator)

| Scenario | Invariant |
| --- | --- |
| Host SIGKILL at `session/prompt` | No false complete; no auto ACP re-run; single attempt row |
| Server SIGKILL mid-ACP | Restart + resume: no false success; ≤1 `session/new` |
| ACP force-exit | Terminal failed/cancelled; null result; one session |
| Server restart after complete | Terminal preserved; no ACP replay |
| Capacity contention (cap=1) | One reservation/mailbox until free |
| Concurrent identical idempotency | One operation/attempt/session |
| Cancel vs barrier race | Terminal cancelled, not success |
| In-process coordinator checkpoints | Single activation; terminal writeback reconcilable (incl. added fail-path points) |

#### D. Authorization matrix (`realProcessAuthorizationMatrix` + complementary suites)

| Probe class | Invariant |
| --- | --- |
| Missing/wrong Bearer | 401 |
| Wrong project / unknown op | Fail closed |
| Wrong lease/dispatch/attempt / stale version | Action not delivered as success rewrite |
| Invalid schema/cursor/pagination | Fail closed |
| Cancel after terminal success | Success preserved |
| Second idempotency on active claim | No second attempt |
| Artifact adversarial (complementary) | Cross-scope grants 403; no path leak |

**Evidence JSON (deterministic):**

- version: `planweave.release-gate.deterministic/v1`
- result: `passed`
- tests: total 25 / passed 25 / failed 0
- gate evidenceDigest: `sha256:82836c0282cece1bf491b64d1b9f65d1a901f9494e1e6a2e20bb3f44944e9479`
- raw file sha256: `3379135bb074cb1285d3899d442e45b7451475e5c2d692ede0331b6dda57dc97`

---

## 5. Security / crash matrices

Covered by RV-002#B-003 (see §4 C–D). Residual documented gaps (not silent passes):

1. Host micro-boundaries without public hooks (unit recovery authoritative).
2. Some domain denials still map to HTTP 500 (`operator_request_failed`) rather than 4xx — denial + no side effect asserted.
3. Fake clocks unsupported on production bins.
4. Live WSS envelope tampering covered by unit/adversarial, not every multi-process injection.

---

## 6. Real ACP result (Host-local) — **FAILED / blocked for supported-version release**

**Command (soft gate, re-run):**

```text
PLANWEAVE_REAL_ACP=1 node scripts/real-acp-host-smoke.mjs --evidence <path>
# equivalent: planweave-agent-host real-acp-smoke --evidence <path>
```

**Observed (sanitized):**

| Field | Value |
| --- | --- |
| result | **`failed`** (not skipped) |
| gateMode | soft |
| profileId | `codex-acp` |
| agentVersion | `1.1.2` |
| protocolVersion (ACP) | `1` |
| sdkPackageVersion | `1.2.1` |
| authenticationStatus | `authenticated` |
| hostVersion | `0.3.0` |
| noCliFallback | `true` |
| preflightReady | `true` |
| protocolNegotiated / sessionCreated / terminalSucceeded | `false` |
| cleanup | `true` |
| diagnostic | `hostError=acp_process_error` (provider usage limit on this Host; preflight auth still works) |

**Release-gate tier:** `local_real_acp_compatibility` → status **`failed`**, `countsAsPass: false`  
**evidenceDigest (gate):** `sha256:3a60e127196a3c6c624d3f3939ee54151d8baff81d5a199f367dbf2d3b28e6e6`  
**raw file sha256:** `ff8a68c4e66e61fc1b14719af379fef6fb5b98c9a718e58fffe0e553b00d7d8b`

**Interpretation:** infrastructure and public ACP path exercised; **execute is not green**. Do **not** treat as supported-version release pass. Re-run hard gate when provider quota is healthy:

```text
PLANWEAVE_REAL_ACP_REQUIRE=1 planweave-agent-host real-acp-smoke --require --profile codex-acp --evidence <path>
```

---

## 7. Certificate-verified transport / VPS

### 7a. `local-tls-fixture` — **PASSED** (not a production VPS claim)

**Command (soft gate, re-run):**

```text
PLANWEAVE_VPS_E2E=1 node scripts/vps-authenticated-e2e.mjs \
  --profile local-tls-fixture --evidence <path>
```

| Field | Value |
| --- | --- |
| result | `passed` |
| environmentClass | **`local-tls-fixture`** |
| runtimeOutcome | **`completed`** (Runtime authoritative) |
| certificateVerifiedTransport | true |
| enrollmentOneTimeToken | true |
| envelopeDigest | `sha256:97d3d3a4b05cff0388d557e925ced8d56a6189d461f1d075cb5eb95acba2fbd3` |
| artifactHash | `sha256:85efd1ae929f7638b1c0fad9e1638e5624658fc3a0af98253529dd638c83d80b` |
| networkInterrupt | coordinator_restart_tls; replayOk + reconnectOk |
| cleanup / credentialsRevoked | true |
| ACP agent | **mock** (`acpMockAgent.mjs success`) — not a live provider |

**Release-gate tier when this file is supplied as VPS evidence:** status **`invalid`**, `countsAsPass: false` — gate correctly rejects `local-tls-fixture` for pre-release.

**evidenceDigest (gate):** `sha256:62db1ce366355d25371e055831be379ee22bac5052fec5a6c8d2a97fadeff530`  
**raw file sha256:** `a1b1fe2e2b782206b7080389bc4469a4c69bc6bbc4579423bfe9455f1ba13e35`

### 7b. `remote-vps` — **BLOCKED (not run)**

**Preconditions missing:** `PLANWEAVE_VPS_E2E_CONFIG` unset; no disposable VPS; no operator token env.

**Soft probe result:**

| Field | Value |
| --- | --- |
| result | **`skipped`** |
| environmentClass | `unavailable` |
| diagnostic | `remote-vps profile requires PLANWEAVE_VPS_E2E_CONFIG absolute path outside the repository.` |
| all checks | false |

**raw file sha256:** `c84ee97f9236b774fcb0e3a9db72656fa8659c7afc4808d729cd6af3c83a98c4`

When supplied as VPS evidence, pre-release tier is **not** passed (`skipped` / unavailable never `countsAsPass`).

**Required operator path (not executed here):**

```text
export PLANWEAVE_VPS_E2E_CONFIG=/absolute/path/outside-repo/vps-e2e.json
export PLANWEAVE_VPS_OPERATOR_TOKEN=...   # never commit
PLANWEAVE_VPS_E2E_REQUIRE=1 planweave-server vps-e2e \
  --require --profile remote-vps --evidence <path>
```

---

## 8. Authoritative Runtime outcome correlation

| Path | Runtime role | Observed |
| --- | --- | --- |
| Deterministic success lifecycle | writeback terminal completed | asserted in suite (identity match) |
| Deterministic failure/cancel | blocked / cancelled receipts | asserted in suite |
| local-tls-fixture e2e | Runtime completed for fixture Block | `runtimeOutcome=completed` + `runtimeResultAuthoritative=true` |
| Real ACP smoke | Host execute only (no full Server remote op in this smoke) | failed before session; cleanup ok |
| remote-vps | n/a | blocked |

Runtime remains the sole authority for graph/package/task rules and terminal writeback; Server/Host do not invent local success independent of Runtime receipts.

---

## 9. Cleanup / revocation status

| Activity | Status |
| --- | --- |
| local-tls-fixture harness state removed | **yes** (`cleanup.harnessStateRemoved=true`) |
| local-tls-fixture credentials revoked | **yes** |
| Deterministic harness temp roots | removed by test `dispose()` |
| Real ACP disposable workspace | cleanup attempted/completed on failed run |
| remote-vps materials | **n/a** (never created) |
| Operator one-time enrollment codes | not retained in evidence JSON |
| Secrets in this checkpoint doc | none embedded |

---

## 10. Release-gate evaluation (authoritative)

**Command:**

```text
node scripts/planweave-release-gate.mjs \
  --deterministic-evidence <det.json> \
  --real-acp-evidence <real-acp.json> \
  --vps-evidence <local-tls-or-remote.json> \
  --report <report.json>
```

**Report (tip `d07e9338`, evaluate-only):**

| Field | Value |
| --- | --- |
| version | `planweave.release-gate/v1` |
| generatedAt | `2026-07-24T05:16:23.992Z` |
| `releaseReady.ci` | **`true`** |
| `releaseReady.supportedVersionRelease` | **`false`** |
| `releaseReady.preRelease` | **`false`** |
| evaluate-only exit code | **`1`** (not pre-release ready) |
| report file sha256 | `e575e06644bc7c07825ec74219d577106fb9475777ea18114b6b60528c7e23c3` |

| Tier | status | countsAsPass | requirement |
| --- | --- | --- | --- |
| deterministic_process_suite | **passed** | true | required_ci |
| local_real_acp_compatibility | **failed** | false | required_supported_version_release |
| remote_authenticated_vps | **invalid** (local-tls-fixture) / **skipped** (remote unavailable) | false | required_pre_release_evidence |

Rollback checklist: all items `status=documented`, `operatorMustConfirm=true` (state backup, install upgrade, credential rotation/revocation, same-major downgrade, no silent rerun, harness cleanup).

---

## 11. Skips / blockers / residual risks

### Blockers (must clear for higher readiness)

1. **Real ACP hard-gate pass** — blocked by provider usage limit / failed execute (`acp_process_error`). Supported-version release remains false until hard-gate **passed** evidence exists (<14 days).
2. **remote-vps hard-gate pass** — blocked by missing disposable VPS + outside-repo config + token. Pre-release remains false until `environmentClass=remote-vps` **passed** evidence exists. `local-tls-fixture` must not be relabeled as VPS.

### Residual risks (accepted for CI readiness; not cleared)

1. local-tls-fixture uses **mock ACP**, not a live provider agent.
2. Live evidence formats may lack first-class `generatedAt` on some producers (mtime fallback for 14-day expiry) — deterministic evidence includes `generatedAt`.
3. Package major matrix is evaluate-time package.json versions, not wire hello package fields (wire is protocol version only).
4. HTTP status mapping for some fail-closed domain errors remains 500 in operator HTTP.
5. Real multi-process suite depends on built dist bins.

### Ownership

- **CI:** deterministic multi-process suite only.
- **Operators:** disposable VPS, TLS material, enrollment tokens, Host-local provider login.

---

## 12. Checkpoint readiness summary

| Readiness class | Status | Rationale |
| --- | --- | --- |
| Deterministic CI / merge confidence for multi-process remote path | **READY** | 25/25 re-run; gate `releaseReady.ci=true` |
| Supported-version release | **BLOCKED** | real ACP execute failed |
| Pre-release (remote authenticated VPS) | **BLOCKED** | remote-vps not run; local-tls-fixture correctly non-counting |

**Honest label for this checkpoint:**  
`ready for deterministic CI / blocked for live pre-release`

---

## 13. How to refresh evidence

```text
# CI tier
pnpm --filter @planweave-ai/server build
pnpm --filter @planweave-ai/agent-host build
pnpm exec vitest run \
  packages/server/src/__tests__/realProcessAcpHarness.test.ts \
  packages/server/src/__tests__/realProcessRemoteBlockLifecycle.test.ts \
  packages/server/src/__tests__/realProcessCrashReplayMatrix.test.ts \
  packages/server/src/__tests__/realProcessAuthorizationMatrix.test.ts

# Or via gate
node scripts/planweave-release-gate.mjs --run-deterministic --report /tmp/release-gate.json

# Live (operator-owned)
PLANWEAVE_REAL_ACP_REQUIRE=1 planweave-agent-host real-acp-smoke --require --evidence /tmp/real-acp.json
PLANWEAVE_VPS_E2E_REQUIRE=1 planweave-server vps-e2e --require --profile remote-vps --evidence /tmp/vps-e2e.json

node scripts/planweave-release-gate.mjs \
  --deterministic-evidence /tmp/det.json \
  --real-acp-evidence /tmp/real-acp.json \
  --vps-evidence /tmp/vps-e2e.json \
  --report /tmp/release-gate.json
```

Live evidence expires after **14 days** (`generatedAt` or file mtime).
