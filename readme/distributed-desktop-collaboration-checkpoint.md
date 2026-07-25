# Distributed Desktop collaboration evidence checkpoint

**Checkpoint id:** `DX-CHECKPOINT#B-001`  
**Assembled at (UTC):** `2026-07-25T17:31:13Z`  
**Branch tip:** `feat/distributed-collaboration` @ `96323a94b4eecb36da4c94f0149c22fdca628718`  
**Verdict:** **Desktop client collaboration surface ready** (trust boundary, typed IPC/read models, people/assignee, scoped Comments/Activity, explicit remote ACP controls, local Auto Run coexistence), with **documented residual Server wire gaps** and environment-limited live multi-user evidence.

This document correlates DX-001 / DX-002 / DX-003 deliverables with a re-run of focused contracts/safeStorage-bridge/IPC/hook/component/i18n/a11y/performance/DOM-boundary/build/Electron smoke checks on the monorepo tip. It does **not** invent UI, fallback data, roles, chat rooms, or workflows to satisfy the gate.

Secrets, device tokens, invitation tokens, and home-directory absolute paths are omitted. Upstream report digests and non-secret commit SHAs are retained for verifiability.

Related domain checkpoints (Server application layer):

- Human collaboration domain: [distributed-human-collaboration-checkpoint.md](distributed-human-collaboration-checkpoint.md)
- Remote execution / release gate: [distributed-remote-execution-checkpoint.md](distributed-remote-execution-checkpoint.md)

---

## 1. Component versions (correlated)

| Component | Package | Version | Notes |
| --- | --- | --- | --- |
| Desktop | `@planweave-ai/desktop` | `0.3.1` | Electron main/preload/renderer collaboration surface |
| Collaboration contracts | `@planweave-ai/collaboration-contracts` | `0.3.0` | Zod-first public human collaboration wire DTOs |
| Distributed protocol | `@planweave-ai/distributed-protocol` | `0.3.0` | Agent Host wire only — **not** mixed into human collab DTOs |
| Runtime | `@planweave-ai/runtime` | `0.3.0` | local claim/submit/Auto Run authority |
| Server | `@planweave-ai/server` | `0.3.0` | human identity + attachment HTTP exist; see residuals |
| Agent Host | `@planweave-ai/agent-host` | `0.3.0` | ACP execution; not Desktop renderer authority |
| CLI | `@planweave-ai/cli` | `0.3.0` | not the collab UI path |
| Node (checkpoint host) | — | `v26.3.0` | `engines.node >= 22.5` |
| pnpm | — | `10.32.1` | monorepo tool |
| OS (checkpoint host) | Darwin arm64 | kernel 25.5.0 | local operator machine |

---

## 2. Upstream task map (evidence sources)

| Task | Delivered boundary | Gate-closing commits | Review |
| --- | --- | --- | --- |
| **DX-001** Typed/secure collab bridge | Contracts package; main `CollaborationClient`; safeStorage vault + profiles; typed IPC/preload/bridge; renderer read-model hub + subscriptions | `1c5083e5` client/contracts; `7f978037` vault/IPC; `fb46fa2e` renderer subscriptions; `9efdfe41` FE-010 cursor continuity + path redaction | REV-001 `needs_changes` → FE-010 resolved → REV-002 **passed** |
| **DX-002** People + assignment UX | Compact people presence; owner invitation/member/device; Task/Block assignee picker; graph/Todo/Search chips from shared hub | `98c232eb` people; `3bcd42ed` picker; `bb9a71b3` surface integration; `4a19f512` FE-011 i18n + shell-only hub owner | REV-001 `needs_changes` → FE-011 resolved → REV-002 **passed** |
| **DX-003** Comments/Activity + remote ACP | Scoped human Comments/Activity; attachment upload; RemoteRunPanel; performance/a11y/e2e scenarios | `bf5a8a5c` comments/activity; `28d50751` remote ACP panel; `91877a65` e2e/a11y/bounds; `96323a94` FE-012 resume identity + local Auto Run wire | REV-001 `needs_changes` → FE-012 resolved → REV-002 **passed** |

### Upstream report digests (`shasum -a 256`, assembly 2026-07-25)

Paths are relative to the PlanWeave canvas `results/` tree (not committed to this repo).

| Artifact | sha256 |
| --- | --- |
| `DX-001/blocks/B-001/runs/RUN-001/report.md` | `b1312e778b696abc20a42285639099ee27baa7c5321f5e3e352a70f2020d5656` |
| `DX-001/blocks/B-002/runs/RUN-001/report.md` | `b51ba06c57b953802b007b94bfa9afa49357563a8e8fcb78f6558d6b6c33f232` |
| `DX-001/blocks/B-003/runs/RUN-001/report.md` | `8ae95ec4ad256d4469b913dd28d77d328bdc381e3393fb244c951231d056ddb8` |
| `DX-001/feedback/FE-010/submissions/FS-001/report.md` | `9e6922fc9dd7cbbbab115b861118a4914f9ac35b648ac3fd6cc7f6b6c6a2b34b` |
| `DX-001/reviews/R-001/attempts/REV-001/review-result.json` | `4f3a91243fdf0b75c27b4e61c2f5a0c0441743d9c0749a16edc2e843c7387884` |
| `DX-001/reviews/R-001/attempts/REV-002/review-result.json` | `bc216cc25fa0680b1d992be45f998a0f4511f894beab507f5da021fc1ce0c6fb` |
| `DX-002/blocks/B-001/runs/RUN-001/report.md` | `d8cf9df07f4ff18c4d193a19e75b6d52aafaad63e124278decea464300c67107` |
| `DX-002/blocks/B-002/runs/RUN-001/report.md` | `7910fc016e9282fa1be72c85e0d8a8855dfea8460fdcc04338960dfdc2126d78` |
| `DX-002/blocks/B-003/runs/RUN-001/report.md` | `678cf61c01bcb8340431b80fe9d50edba66126fd7c6784346170aab412ec819c` |
| `DX-002/feedback/FE-011/submissions/FS-001/report.md` | `a7c306fe8df8f9bb8f5be01e89d1092e33dfd72bde80cf40101098c34af6326a` |
| `DX-002/reviews/R-001/attempts/REV-001/review-result.json` | `99221f417b66b39f8376d3165329e28a0ac7a30e1687904e215536c0e888ea8b` |
| `DX-002/reviews/R-001/attempts/REV-002/review-result.json` | `352a3919b2f61f456b2fb9ec26657afbccf037910ba7fb5ddddc6916215e041a` |
| `DX-003/blocks/B-001/runs/RUN-001/report.md` | `deed9c65075e3e14510dc6a1f41136c30079a027214a68c9b2b7dd4a3871f99c` |
| `DX-003/blocks/B-002/runs/RUN-001/report.md` | `93ba6153d30b4acd7eaabe9f9e9d1f00a85927a950a5a6c7a27e88c942153afc` |
| `DX-003/blocks/B-003/runs/RUN-001/report.md` | `4b8ec3fe4c5975d393484a84a6aa6a2b961cc14d292a8778c963b4b3b49bd452` |
| `DX-003/feedback/FE-012/submissions/FS-001/report.md` | `ae11b4980e6269c84509d29a08ebbbd2a9be06a00c82a3d0b3fc883ed7673cc5` |
| `DX-003/reviews/R-001/attempts/REV-001/review-result.json` | `54304627ba0460259693b0794e1d54f0f7eabebe28bfe87790667487b2437f61` |
| `DX-003/reviews/R-001/attempts/REV-002/review-result.json` | `e7b9f1fd3b93f23dbd997342ceaa4a6045b286a05b1020930cb26cedc056e579` |

---

## 3. End-to-end data flow (Desktop collaboration)

```text
Renderer (hooks / view-models / panels)
  │  named methods + status/observer subscriptions only
  ▼
Preload `planweaveCollaboration` (typed PlanWeaveCollaborationApi)
  │  ipcRenderer.invoke / on  — channels in packages/desktop/src/shared/collaboration.ts
  ▼
Main collaborationHandlers → CollaborationService
  │  owns profiles, vault, session client, observer cursor memory, Authorization headers
  ▼
CollaborationClient (HTTPS + WSS human observer)
  │  Zod-parse every response/event via @planweave-ai/collaboration-contracts
  ▼
Server public wire (partial — see §10 residuals)
  • human identity HTTP: /api/v1/projects/:projectId/human/*
  • attachments: /api/v1/projects/:projectId/attachments/*
  • wire-encoded (client ready; Server HTTP residual): assignments, comments, activity,
    human observer WSS /human/observe, project-scoped human remote-operations
```

**Explicit non-paths for the renderer:**

| Forbidden | Enforced by |
| --- | --- |
| Bearer device token / ciphertext | vault + handoff strip + smuggle rejection |
| `fetch` / raw sockets / Electron `safeStorage` | preload surface only |
| Server implementation / SQLite | separate deployable; contracts package only |
| Host mailbox tables / ACK / Host credentials | distinct `/human/observe` contract |
| DOM as business state | hooks + bridge + DOM-boundary check |

---

## 4. Surface → authority / action / state matrix

### 4.1 Trust boundary & credentials

| Concern | Authority | Actions (IPC) | State / fence | Explicit non-authority |
| --- | --- | --- | --- | --- |
| Connection profile (non-secret) | Main `CollaborationProfileStore` (`profiles.json` mode 0600) | upsert/remove/setActive/clear | `serverBaseUrl` + `projectId` + insecure-loopback flag | deviceToken; credential path |
| Device credential | Main `CollaborationCredentialVault` + OS `safeStorage` | import/clear; bootstrap/consume handoff | `persisted` \| `session-only` \| `missing`; no plaintext on disk when encryption unavailable | renderer return of token; cookies/`localStorage` |
| Session lifecycle | Main `CollaborationService` + client | connect/disconnect | phases: `idle`/`ready`/`connecting`/`connected`/`error` | Host enroll; operator bearer |
| Observer continuity | Main `lastValidatedObserverCursor` (FE-010) | startObserver resume on reconnect | cleared on logout / profile_removed / shutdown | cold app restart still starts cursor 0 + authoritative load |
| Path leakage | redaction + path-free vault errors (FE-010) | all IPC errors | absolute paths → `<redacted-path>` | success-path status already path-free |
| DTO authority | `@planweave-ai/collaboration-contracts` Zod | dual-parse Server alignment tests | wire views/pages/wire commands (no actor) | Server domain schemas with digests stay in Server |

### 4.2 People / membership / invitations / devices

| Surface | UI entry | Authority / read model | Actions | Owner-only | States shown |
| --- | --- | --- | --- | --- | --- |
| People presence | compact header/sidebar control | shared hub membership + host projections | open panel (lazy details) | no | online/offline session; member count |
| Members list | `PeoplePanel` | Server membership page via IPC | promote/demote/remove (confirm) | promote/demote/remove others | owner \| member; inactive |
| Invitations | people panel (on demand) | invitation page | create / revoke; one-shot token display + copy warning | create/revoke | pending/consumed/revoked/expired (projection) |
| Devices | people panel | own vs project device lists | revoke own / owner revoke member device | project revoke | active/revoked/expired |
| Agent Hosts | separate section in people panel | host facts projection | view status/capabilities only (no Host credential mint) | n/a | online/offline/degraded; capacity; capability mismatch |

**IA invariant:** no standalone Team Mode wizard; Linear-style compact entry into existing workspace shell.

### 4.3 Assignment (coordination metadata only)

| Surface | Work-item kinds | Allowed targets | Authority | Does **not** |
| --- | --- | --- | --- | --- |
| Task assignee picker / chip | Task | `unassigned`, `human` | `work_assignments` via wire update + CAS `expectedRevision` | start Host dispatch; claim Runtime Block |
| Block assignee picker / chip | Block | + `exact_host`, `automatic_host` | same | auto-start remote ACP |
| Graph / Todo / Search chips | both | display from shared `AssigneeSurfaceIndex` | hub assignment map (shell-owned canvas filter) | per-card sockets |

| State | How expressed |
| --- | --- |
| Offline / auth_expired / forbidden | mutation phase + picker unavailable reasons |
| Stale revision | conflict → refresh + retry; never optimistic confirm |
| Host offline / capacity / capability / revoked | eligible-assignee availability projection |
| Task machine targets | view-model omits + controller rejects `exact_host`/`automatic_host` (FE-011) |
| Submitting | pending mutation; chips stay confirmed-only for success appearance |

**Hub ownership (FE-011):** only `useCollaborationSurface` sets `manageActiveProject: true`. People/assignee/comments/activity/remote controllers subscribe with `manageActiveProject: false`.

### 4.4 Human Comments / Activity / attachments

| Surface | Scope | Authority | Distinct from |
| --- | --- | --- | --- |
| `CommentsPanel` | selected Task/Block WorkItemRef | comment rows + CAS revision; SafeMarkdown text tree | `TaskWorkspaceConversation` (Agent interaction) |
| Attachments | pending → upload → finalize bind | comment-attachment blobs + human membership ACL | dispatch `artifact_grants` |
| `ActivityPanel` | project and/or work-item filter | append-only activity projection (membership/assignment/comment/remote_run) | ACP event stream; mailbox ACK |

| Action | Offline / conflict behavior |
| --- | --- |
| create / edit / tombstone | pending → confirmed \| rejected; offline never confirms |
| edit/tombstone | requires `expectedRevision`; conflict forces reload |
| pagination | cursor pages; default 20 / max 50; multi-page window bound (render benchmark) |

### 4.5 Local Auto Run vs remote ACP run

| Concern | Local Auto Run | Remote dispatch |
| --- | --- | --- |
| Authority enum | `local_auto_run` (Runtime) | `remote_dispatch` (`data-authority="remote_dispatch"`) |
| UI | existing mini panel / scope / Task Workspace conversation | `RemoteRunPanel` on Block inspector |
| Start | Runtime Auto Run controls | explicit human `dispatch` (assignment eligibility gated) |
| Events | local run records / ACP conversation components | Server observation + event replay + interactions |
| Resume | local recovery paths | `resume_same_session` with observation-backed recovery (FE-012) |
| Coexistence | unfinished Block run records → `localAutoRunActive` blocks remote dispatch | never merges status machines |

**Remote authorized actions (view-model):**

| Action | Availability fences |
| --- | --- |
| `dispatch` | assignment eligible; not offline; not `local_run_active` |
| `answer_interaction` | pending interaction present |
| `cancel` / `fail_interruption` / `retry_new_attempt` | lifecycle + identity; destructive confirms |
| `resume_same_session` | interruption recovery evidence + prior lease; mints **only** fresh lease id; recovery ids never UI-minted |

### 4.6 Offline / auth / conflict / project switch

| Scenario | Expected Desktop behavior (client) |
| --- | --- |
| Offline mutation | stays pending/rejected; `mutationAppearsSuccessful` is confirmed-only |
| Auth expired | session/error surfaces; observer `auth_expired`; no reconnect loop on expired token |
| Stale assignment/comment revision | conflict path + refresh |
| Project / profile switch | hub clear + client dispose; credentials not cross-smuggled |
| Disconnect/reconnect (same process) | observer cursor resumed (FE-010); catch-up or authoritative refresh on gap |
| App cold start | cursor 0 + `setActiveProject` authoritative load (documented residual) |

### 4.7 Performance / subscription model

| Rule | Evidence |
| --- | --- |
| One active collab session / one observer hub | `CollaborationService` + shared read-model hub controller |
| Keep connection warm; lazy heavy panels | comments/activity/invitations/deep remote diagnostics load when opened |
| No one-observer-per-item | single observer signal channel → hub invalidation |
| Virtualize / page long histories | controller page bounds + `collaborationRenderBenchmark` |
| Code-split collab chunk | desktop build emits `collaboration-*.js` + `remoteRun-*.js` |

---

## 5. Feedback resolutions (blocking reviews)

| Feedback | Task | Finding | Resolution commit | Status |
| --- | --- | --- | --- | --- |
| **FE-010** | DX-001 | Observer cursor dropped on dispose; absolute paths in IPC errors | `9efdfe41` | resolved → REV-002 passed |
| **FE-011** | DX-002 | EN-only assignee labels; multi hub owners; Task machine targets not hard-rejected | `4a19f512` | resolved → REV-002 passed |
| **FE-012** | DX-003 | Resume minted lease/recovery ids; BlockInspector missing `localAutoRunActive` | `96323a94` | resolved → REV-002 passed |

**No open DX review feedback.** No defect was returned to owning Tasks as a checkpoint-blocking failure during this assembly.

---

## 6. Verification (re-run on tip `96323a94`)

All commands run in the monorepo working tree; results inspected at assembly.

### 6.1 Focused collaboration + Auto Run regression + i18n

```text
pnpm exec vitest run \
  packages/collaboration-contracts/src/__tests__/contracts.test.ts \
  packages/server/src/__tests__/collaborationContractsAlignment.test.ts \
  packages/desktop/src/__tests__/collaborationClient.test.ts \
  packages/desktop/src/__tests__/collaborationBridge.test.ts \
  packages/desktop/src/__tests__/collaborationReadModels.test.ts \
  packages/desktop/src/__tests__/collaborationReadModelHub.test.ts \
  packages/desktop/src/__tests__/assignmentViewModels.test.ts \
  packages/desktop/src/__tests__/assigneePicker.test.tsx \
  packages/desktop/src/__tests__/assigneePickerController.test.ts \
  packages/desktop/src/__tests__/assigneeSurfaceViewModels.test.ts \
  packages/desktop/src/__tests__/peoplePanel.test.tsx \
  packages/desktop/src/__tests__/peopleViewModels.test.ts \
  packages/desktop/src/__tests__/commentViewModels.test.ts \
  packages/desktop/src/__tests__/commentsPanel.test.tsx \
  packages/desktop/src/__tests__/commentsPanelController.test.ts \
  packages/desktop/src/__tests__/remoteRunViewModels.test.ts \
  packages/desktop/src/__tests__/remoteRunPanel.test.tsx \
  packages/desktop/src/__tests__/remoteRunPanelController.test.ts \
  packages/desktop/src/__tests__/blockInspectorRemoteRunCoexistence.test.tsx \
  packages/desktop/src/__tests__/collaborationIntegrationScenarios.test.tsx \
  packages/desktop/src/__tests__/collaborationAccessibility.test.tsx \
  packages/desktop/src/__tests__/collaborationRenderBenchmark.test.ts \
  packages/desktop/src/__tests__/autoRunMiniPanel.test.tsx \
  packages/desktop/src/__tests__/autoRunScopeControl.test.tsx \
  packages/desktop/src/__tests__/floatingAutoRunControl.test.tsx \
  packages/desktop/src/__tests__/taskWorkspaceShell.test.tsx \
  packages/desktop/src/__tests__/taskWorkspaceRenderBenchmark.test.ts \
  packages/desktop/src/__tests__/rendererI18n.test.ts
```

**Result:** 28 files / **177 tests passed**, duration ~4.7s.

Coverage themes: contracts dual-parse; client HTTP/WSS (fake); vault/IPC redaction + cursor resume; read-model offline/conflict/project switch; people/assignee i18n; comments/activity; remote resume identity; local Auto Run coexistence; structural render bounds; a11y live regions / keyboard; catalog en/zh-CN.

### 6.2 IPC / preload parity

```text
pnpm exec vitest run \
  packages/desktop/src/__tests__/ipcContract.test.ts \
  packages/desktop/src/__tests__/preloadBridge.test.ts
```

**Result:** 2 files / **28 tests passed** (ipcContract re-run after desktop/runtime build).

Collaboration IPC registry surface (40 named channels including 2 push channels): profile/session/credential, identity, assignment, comments/activity, attachments, remote operation observe/actions/events/interactions, `statusChanged`, `observerSignal`.

### 6.3 DOM boundaries

```text
pnpm check:dom-boundaries
```

**Result:** passed (**459 files** scanned). Collaboration UI does not read business state from DOM.

### 6.4 Desktop build

```text
pnpm --dir packages/desktop build
```

**Result:** success. Renderer chunks include lazy `collaboration-*.js` (~108 kB) and `remoteRun-*.js` (~7.9 kB); not forced into every route.

### 6.5 Electron smoke

```text
pnpm --filter @planweave-ai/desktop smoke
```

**Result:** success. Event `PLANWEAVE_DESKTOP_SMOKE_READY` with `autoRunPhase: stopped`, Task Workspace ready, local Auto Run mini panel / record path covered.

**Honest scope:** smoke project is **local-only**. It does **not** exercise remote Server membership, human observer WSS, comments/activity panels against a live coordinator, or multi-user invitation handoff.

### 6.6 Packaged smoke

**Not run.** `smoke:packaged:mac` / `verify:packaged:mac` require packaging artifacts and are opt-in. Regular Electron smoke passed; packaged installer is residual environment work.

### 6.7 Performance evidence nature

| Check | Nature |
| --- | --- |
| `collaborationRenderBenchmark` | structural page limits and event-burst cursor dedupe — **not** wall-clock FPS |
| `collaborationAccessibility` | live regions, keyboard tab order, reduced-motion class absence |
| Visual CLS / real WSS flood | **not** measured with a profiler against live multi-process Server |

### 6.8 Not claimed as DX gate evidence

- Full monorepo `pnpm test`
- Live multi-operator Desktop against production-like Server/Host matrix
- Packaged macOS/Windows installer smoke
- Server HTTP implementation of assignment/comment/activity/human observer/project-scoped human remote-ops (client encodes wire; see residuals)

---

## 7. Manual / browser / smoke observations

| Observation | Result |
| --- | --- |
| Electron smoke boots bridge + Auto Run stopped | yes (`PLANWEAVE_DESKTOP_SMOKE_READY`) |
| Task Workspace open/return + run detail | covered by smoke `rendererManual` |
| Collaboration connect/join/invite live UI | **not** in smoke path (mock-bridge integration tests only) |
| Multi-window people/assignee conflict with real WSS | **not** exercised live |
| Packaged app credential vault on real OS keychain | unit covers available/unavailable; live keychain not claimed |

---

## 8. Cross-surface separation checks

| Boundary | Finding on tip |
| --- | --- |
| Human collab contracts vs Host protocol | separate package; no Host mailbox types in Desktop collab client |
| Device token vs operator/Host credentials | vault + distinct parsers; renderer never receives token after handoff |
| Assignment vs Runtime claim / local Auto Run | assignment update-only; remote panel separate authority attribute |
| Human comments vs Agent conversation | separate panels; comments do not replace `TaskWorkspaceConversation` |
| Activity vs ACP events | activity projection summaries vs remote event replay components |
| Attachment ACL vs dispatch artifacts | comment-attachment paths; not artifact grants |
| Shell hub ownership | single `manageActiveProject: true` owner |
| DOM business state | forbidden; DOM-boundary check green |

---

## 9. Removed-concept / non-goal search (Desktop collab surface)

| Concept | Result |
| --- | --- |
| Standalone Team Mode wizard | **Absent** — compact people presence only |
| Chat rooms / channels product | **Absent** — scoped WorkItem comments |
| Merged local+remote run enum | **Rejected** — `RunAuthorityKind` dual enum |
| Renderer-held deviceToken | **Rejected** — stripped handoff + vault |
| Generic RPC framework | **Absent** — named IPC methods only |
| DOM-derived assignee/run state | **Absent** |

---

## 10. Residual risks and environment gaps (honest)

These are **not** silent failures of the reviewed Desktop tasks. No new UI or fallback product code was added in this checkpoint to paper over them.

| Gap | Owning surface | Severity | Notes |
| --- | --- | --- | --- |
| Server HTTP for assignment list/get/update/eligible-assignees | Server transport (post-HC application services) | **Product / wire** | Desktop client paths exist; application services exist; public HTTP residual from HC checkpoint still applies |
| Server HTTP for comment create/edit/tombstone/list + activity list | Server transport | **Product / wire** | Same residual class as HC-CHECKPOINT |
| Human observer WSS `/api/v1/projects/:projectId/human/observe` | Server transport | **Product / wire** | Client reconnect/catch-up tested with fakes |
| Project-scoped human remote-operations HTTP (`/api/v1/projects/:projectId/remote-operations*`) | Server transport | **Product / wire** | Operator remote-ops under `/api/v1/remote-operations*` exist with **operator** bearer; not a substitute for human device auth without an adapter |
| Live multi-user Desktop E2E (invite, observer fan-out, conflict under real WSS) | Environment / future gate | Medium | Mock-bridge e2e only on this tip |
| Packaged installer smoke | Desktop packaging | Low/opt-in | Regular smoke passed |
| App cold-start observer cursor persistence | Desktop main (optional enhancement) | Low | Authoritative reload on project bind mitigates |
| Resume fresh lease TTL fixed 25s | Desktop remote panel | Low | Custom shorter Server `leaseDurationMs` could reject |
| Local Auto Run active signal from unfinished Block run records | Desktop BlockInspector | Low | Does not subscribe to in-memory phase before first record |
| Visual profiler / burst-input latency | Performance QA | Low | Structural bounds only |
| Full monorepo suite | CI | Out of DX scope | Not used as this gate |

**No open DX review feedback.** FE-010 / FE-011 / FE-012 are resolved. Checkpoint does **not** return defects to DX-001/002/003 as blocking failures; Server wire gaps are pre-existing product residuals, not regressions of the Desktop reviews.

---

## 11. Checkpoint readiness

| Criterion | Status |
| --- | --- |
| DX-001/002/003 final reviews `passed` | yes |
| FE-010 / FE-011 / FE-012 resolved with re-review | yes |
| Device token never in renderer after handoff; safeStorage or session-only | yes |
| Named typed IPC; no raw renderer network | yes |
| Compact people + assignment in existing workspace (no Team Mode) | yes |
| Assignment ≠ execution; remote dispatch explicit | yes |
| Human comments ≠ Agent conversation ≠ ACP events ≠ local Auto Run | yes |
| Resume recovery identity observation-backed | yes |
| Local Auto Run coexistence wired on BlockInspector | yes |
| Focused collab + Auto Run + i18n tests green (177) | yes |
| IPC/preload + DOM-boundary + desktop build + Electron smoke | yes |
| Packaged smoke | **no** (residual) |
| Live Server multi-user collab wire complete | **no** (residual — Server HTTP/observer gaps) |
| Unresolved trust-boundary defect in reviewed Desktop code | **no** |

**Conclusion:** Desktop collaboration is **trust-bounded, typed, and integrated into the existing workspace** across DX-001–003, with reviews passed and focused verification re-run green on tip `96323a94`. Checkpoint **passes Desktop client acceptance** with residual Server wire/environment gaps listed above — not as unfixed trust-boundary regressions of the reviewed Desktop tasks.

**Honest label:**  
`ready for Desktop collaboration client CI and local smoke; blocked for full live multi-user collaboration until Server exposes the remaining human assignment/comment/activity/observer/remote-run wire paths (or an equivalent human-authenticated adapter).`
