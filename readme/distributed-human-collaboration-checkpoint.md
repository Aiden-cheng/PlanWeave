# Distributed human collaboration evidence checkpoint

**Checkpoint id:** `HC-CHECKPOINT#B-001`  
**Assembled at (UTC):** `2026-07-24T08:05:00Z`  
**Re-verified at (UTC):** `2026-07-25T14:08:58Z`  
**Branch tip:** `feat/distributed-collaboration` @ `53eb525c3720062369fa80491a92898cd4059841`  
**Verdict:** **Domain ready** for identity / assignment / comment-activity collaboration semantics, with **documented residual product-surface gaps** (comment/activity HTTP, automatic activity projection wire-up, soft retention purge).

This document correlates HC-001 / HC-002 / HC-003 deliverables with a re-run of focused schema/policy, SQLite, HTTP/auth, WorkItemRef, dispatch race, blob ACL, projection, and credential-isolation tests on the monorepo tip. It does **not** invent features, roles, chat rooms, or workflows to satisfy the gate.

Secrets, device tokens, invitation tokens, digests used as secrets, and home-directory paths are omitted. Upstream report digests and non-secret commit SHAs are retained for verifiability.

---

## 1. Upstream task map

| Task | Delivered boundary | Gate-closing commits | Review |
| --- | --- | --- | --- |
| **HC-001** Human identity / membership / invitations / devices | Pure model + policy; SQLite v16; loopback bootstrap + human HTTP | `2740e8d7` model; `15454885` persist; `41f8c629` HTTP; `7a49f79a` FE-008 revoke scope + bootstrap recovery | REV-001 `needs_changes` → FE-008 resolved → REV-002 **passed** |
| **HC-002** Task/Block assignment + dispatch gate | Pure contracts; SQLite v17; dispatch gate + durable host selection v18 | `99578648` contracts; `6930474b` persist; `6f269ff3` dispatch wire; `8fa0c09d` FE-009 durable selection | REV-001 `needs_changes` → FE-009 resolved → REV-002 **passed** |
| **HC-003** Comments / attachments / activity | Pure contracts; attachment HTTP + blobs v19; comment/activity SQLite v20 | `bdc680f4` contracts; `8fbcec4f` attachments; `53eb525c` persist + projection | REV-001 **passed** |

### Upstream report digests (`shasum -a 256`)

Computed at assembly (`2026-07-24`) and re-checked at re-verification (`2026-07-25T14:08:58Z`); digests unchanged. Paths are relative to the PlanWeave canvas `results/` tree (not committed to this repo).

| Artifact | sha256 |
| --- | --- |
| `HC-001/blocks/B-001/runs/RUN-001/report.md` | `e59293656d50adfd9906cc3a5edc316885a62ee07fcf2da9e20592c8144df6b2` |
| `HC-001/blocks/B-002/runs/RUN-001/report.md` | `e367c564340fe6febec4b474eb21009199b073995caf8a6f1c525e239f8d74a6` |
| `HC-001/blocks/B-003/runs/RUN-001/report.md` | `cea9adc6ba493e03587d59272b840a403d2966ef0920714d07b9cec95e22f13a` |
| `HC-001/reviews/R-001/attempts/REV-001/review-result.json` | `41a281eca2f9563f2c53e83293874484d3062c09de7ec5c9271077c797936a4b` |
| `HC-001/reviews/R-001/attempts/REV-002/review-result.json` | `69dcf102ccb201938ba1e9a7a38ed2da61c41bb354967594f651f5c1e59f9b06` |
| `HC-001/feedback/FE-008/submissions/FS-001/report.md` | `73d1f3d51d919506465fa8355595334ce43b3470b0d2dc1cf9c9c836f2c23784` |
| `HC-002/blocks/B-001/runs/RUN-001/report.md` | `bcca0f1d42f0d40da2d64847ec37325bdf62001f064394d0dd7c169deaf2ad91` |
| `HC-002/blocks/B-002/runs/RUN-001/report.md` | `b1bd855e734d65b08ea02141694ad1a3b88fa713c0718e64aded7aa5c54a6c97` |
| `HC-002/blocks/B-003/runs/RUN-001/report.md` | `cae940e1e8d4e9e38de7aad10d3c6013589c2674bb6329f36719299617aabc3b` |
| `HC-002/reviews/R-001/attempts/REV-001/review-result.json` | `cb03677c5b12de628eaad3cd3c9f2a59aa3ac4f8143b70a40d49ded3d4e08363` |
| `HC-002/reviews/R-001/attempts/REV-002/review-result.json` | `c27a36afdcdfd4de11e2da61d611ecab7173ed00e79fcbf42fdd80c1498bdfbb` |
| `HC-002/feedback/FE-009/submissions/FS-001/report.md` | `711f5e913fcc17e3c0ce65ea7339b0999cc7207e9a80d1aaeb07658a455feabe` |
| `HC-003/blocks/B-001/runs/RUN-001/report.md` | `848ec48769c9750e8e08b169fdb3dbad9ba9cebe764b62562666a15dcb54c664` |
| `HC-003/blocks/B-002/runs/RUN-001/report.md` | `e172456d6dc1dcb69a32e8f1ca668d9ec5ad0221a6b4ea86aee7dd647aff0efe` |
| `HC-003/blocks/B-003/runs/RUN-001/report.md` | `81d58b98ba06ccc5e0aa8ed7501766e74f0d4995caaa24e0bf331faf0a29d5f3` |
| `HC-003/reviews/R-001/attempts/REV-001/review-result.json` | `d5686b63d04f0719f742cf202f312cec628ec597fd2b31ea3d8cd16b63a308cf` |

---

## 2. Authority matrix (one concern → one authority)

| Concern | Authority | Lifecycle / fence | Explicit non-authority |
| --- | --- | --- | --- |
| Human principal identity | `human_principals` + device digests | Soft device revoke/expiry; principal rows retained | Host id, operator token, `ActorRef` display |
| Project membership role | `project_memberships` (`owner` \| `member` only) | Soft `revoked_at`; last-owner protected under write txn | Invitation bearer after consume; Host enrollment |
| Invitation | `project_invitations` (role **always** `member`) | Single-consume + expiry/revoke; SHA-256 only stored | Network first-owner; generic roles |
| Human device secret | one-shot mint `pw_hdev_…`; durable SHA-256 only | Usability = digest match + not revoked/expired | `pw_host_`, `pw_enroll_`, operator bearer |
| Human action authorization | central `authorizeHumanAction` policy table | Every human route/service reuses named actions | Ad-hoc role strings in handlers; Host policy |
| WorkItemRef existence / kind | Plan Package via Runtime `compileTaskGraph` port | Create/update resolve live package facts | Assignment blob; comment body; UI lists |
| Block requiredCapabilities | Plan Package Block requirements | Automatic Host selection re-reads package facts | Assignment target payload |
| Assignment target + CAS revision | `work_assignments` | Compare-and-set revision; never claims/runs | Runtime claim state; dispatch lease as assignment truth |
| Dispatch Host selection snapshot | `remote_operations.host_selection_json` at dispatch begin | Durable fingerprint preferred on reenter; clear only on terminal | Later assignment reassignment; in-memory-only map |
| Host reservation / lease | Host reservation + remote operation store | Exact preferred Host pin; fail closed if offline/capacity | Assignment write path |
| Comment body / revision | `comments` row + CAS `revision` | Author edit; author/owner tombstone; body retained on tombstone | Host author; Runtime claim/submit |
| Comment attachment bytes | `comment_attachment_*` + `comment-attachments/` FS root | Stage → hash stream → finalize → bind; human membership ACL | `artifact_grants`, dispatch artifact HTTP, bare digest knowledge |
| Activity feed | `activity_records` + `activity_projection_outbox` | Append-only; UNIQUE `(project_id, source_kind, source_id)`; outbox reconcile | Chat rooms; ACP streams; mailbox delivery ACKs; proposals/consensus |

---

## 3. Principal / credential / action authorization matrix

Subject kinds are **not** collapsed into one principal union for auth:

| Subject | Credential shape | May authenticate as human? |
| --- | --- | --- |
| `unauthenticated` | none | no |
| `local_administrative_proof` | loopback + local-admin bootstrap payload | bootstrap only (not network human) |
| `invitation_bearer` | `pw_inv_…` (body, one-shot) | join only → grants `member` |
| `human` (`HumanAuthContext`) | `Authorization: Bearer pw_hdev_…` + active membership | yes |
| Host credential | `pw_host_…` | **no** (401 on human routes) |
| Host enrollment | `pw_enroll_…` | **no** |
| Operator bearer | operator token | **no** on human collaboration surfaces |

### Central policy (`authorizeHumanAction`)

| Action | Unauth | Invite | Member | Owner | Local admin |
| --- | --- | --- | --- | --- | --- |
| `bootstrap_owner` | deny | deny | deny | deny | **allow** (idempotent same principal; conflict other owner) |
| `join_project` | deny | **allow** (member only) | deny | deny | deny |
| `view_project` / `view_members` | deny | deny | allow | allow | deny |
| `create_invitation` / `revoke_invitation` | deny | deny | deny | allow | deny |
| `list_own_devices` / `revoke_own_device` | deny | deny | own | own | deny |
| `list_project_devices` | deny | deny | deny | allow | deny |
| `revoke_member_device` | deny | deny | deny | allow **only if** target has active membership on same project | deny |
| `remove_member` | deny | deny | self | self/others | deny |
| `promote_owner` / `demote_owner` | deny | deny | deny | allow (last-owner protected) | deny |
| `assign_work` | deny | deny | allow | allow | deny |
| `comment` | deny | deny | allow | allow | deny |
| `view_activity` | deny | deny | allow | allow | deny |
| `remote_run_control` | deny | deny | allow | allow | deny |

**FE-008 (resolved):** cross-project device revoke requires `targetDeviceOwnerMembershipActive`; bootstrap re-mints device token when no usable active device remains.

---

## 4. WorkItemRef / assignment / dispatch matrix

### Assignment targets

| Target | Task | Block | Live checks (never from assignment blob) |
| --- | --- | --- | --- |
| `unassigned` | yes | yes | — |
| `human` + principalId | yes | yes | active project membership |
| `exact_host` + hostId | **no** | yes | exists, not revoked, authorized for project, satisfies **current** package capabilities |
| `automatic_host` | **no** | yes | capabilities from package at dispatch; no capability list on target |

Assignment is **coordination metadata only**: update never mutates Plan Package, never claims a Block, never starts Host dispatch.

### Dispatch gate (revalidated before reservation)

| Assignment | `allowHumanOverride` | Result |
| --- | --- | --- |
| human / unassigned | false | `work_not_agent_assigned` |
| human / unassigned | true | override selection (operator-compatible default may enable) |
| exact_host H | * | pin H; mismatch requestedHostId → conflict |
| automatic_host | * | automatic + package `requiredCapabilities` |
| stale `expectedAssignmentRevision` | * | `work_revision_conflict` |
| Task work item | * | kind mismatch (no agent Host target on Task) |

### Durable selection fingerprint (FE-009)

At dispatch begin, authorized selection (`selection`, `preferredHostId`, `assignmentRevision`, target, requiredCapabilities) is persisted on `remote_operations.host_selection_json`. Reenter prefers that snapshot and **must not** re-derive from a later assignment. Same-process reassignment keeps reserved Host; restart path pins original exact Host (integration coverage). Missing fingerprint with configured gate fails closed.

---

## 5. Content ACL matrix (comments / attachments)

| Operation | Auth | Scope fence | Denial examples |
| --- | --- | --- | --- |
| Stage / upload / finalize pending attachment | human device + `comment` action | `projectId` + uploader ownership of pending row + TTL/status | Host token 401; foreign principal; expired pending |
| Download by digest / comment binding | human member/owner on project | project-scoped blob + binding/pending existence | Cross-project digest guess 401/404; bare digest without membership |
| Create comment | human + package WorkItemRef present | project + WorkItemRef; optional finalized attachments bind in txn | Removed work item; removed member; Host author schema reject |
| Edit comment | author + CAS `expectedRevision` | same project/comment | Non-author; revision conflict; tombstoned |
| Tombstone comment | author or owner + CAS | soft-delete; body retained durable; display redacts body | Already tombstoned; foreign project |
| List comments | member/owner | project + WorkItemRef keyset | Cross-project |

Attachment storage is **separate** from dispatch artifacts:

| Concern | Comment attachments | Dispatch artifacts |
| --- | --- | --- |
| FS root | `comment-attachments/` | artifact store root |
| DB | `comment_attachment_*` | `artifact_blobs` / `artifact_grants` / links |
| Auth | human membership + comment scope | Host + exact grant tuple |
| Download headers | `Content-Disposition: attachment`, `nosniff`, CSP sandbox | Host grant stream rules |

---

## 6. Activity delivery / projection matrix

| Source kind | Types (closed enum) | Writer path | Idempotency |
| --- | --- | --- | --- |
| `membership` | joined / left / removed / owner promoted / demoted | explicit `ActivityProjectionService` after membership success | UNIQUE source key |
| `assignment` | `assignment_updated` | explicit projection after assignment write | UNIQUE source key |
| `comment` | created / edited / tombstoned | same write transaction as comment mutation (outbox + project) | UNIQUE + outbox |
| `remote_run` | started / succeeded / failed / interrupted | explicit projection after remote lifecycle | UNIQUE source key |

**Not present:** proposal, consensus, chat, ACP token/tool streams, mailbox delivery ACKs, prompts/secrets/results in summaries.

Delivery semantics:

1. Comment path: outbox insert (`ON CONFLICT DO NOTHING`) → idempotent activity insert → `projected_at`.
2. Other sources: caller invokes projection service (no ambient event bus).
3. `reconcileOutbox(limit)` drains pending rows; safe to re-run.
4. Soft retention constant is **guidance only** (no purge job yet); tombstones intentionally indefinite for audit.

---

## 7. Cross-domain separation checks

| Boundary | Finding |
| --- | --- |
| Human auth vs Host auth | Separate parsers (`parseHumanDeviceBearer` vs host hash path); Host-shaped tokens → 401 on human + attachment routes |
| Human content vs artifact grants | Comment policy/blob store never consult `artifact_grants` |
| Assignment vs Runtime claim | Assignment service comments and policy explicitly non-claiming; dispatch integration does not treat claim state as assignment authority |
| Comments vs Runtime claim/submit/review | Comment module has no claim/submit/review/taskManager writes |
| Activity vs mailbox | Activity tables/types are collaboration projection; mailbox state/delivery untouched by migrations v16–v20 |
| HC modules vs planning/proposals product | `packages/server/src/planning` and `proposals` contain only `__tests__` residual dirs; no product imports from identity/work/comments/attachments into those domains |

---

## 8. Removed-concept search results

Searched `packages/server/src/{identity,work,comments,attachments}` and related migrations:

| Concept | Result |
| --- | --- |
| Chat rooms / channels | **Absent** as tables/types; comments schema documents “no chat rooms” |
| Proposal / consensus streams | **Absent** from activity type enum and comment schemas; only explicit non-goal comments |
| Generic principal union for auth | **Rejected by design** — separate subject kinds in `HumanPolicySubject` |
| Extra membership roles beyond `owner`/`member` | **Absent** — invitation role is literal `member` only |
| Second graph / Planning Room as collaboration ACL | **Not** used by HC modules |
| Host-as-comment-author | Schema requires `authorHumanPrincipalId`; Host author rejected in tests |
| Workflow engines / role workflows | **Absent** |

Mentions of “proposal”, “consensus”, or “chat” in HC sources are **negative documentation** (non-goals), not implementations.

---

## 9. Schema migrations (human collaboration)

| Version | Tables / change |
| --- | --- |
| v16 | `human_principals`, `project_memberships`, `project_invitations`, `human_device_credentials` |
| v17 | `work_assignments` (CAS revision, target union columns) |
| v18 | `remote_operations.host_selection_json` durable dispatch selection fingerprint |
| v19 | `comment_attachment_blobs`, pending uploads, bindings (separate from artifact grants) |
| v20 | `comments`, `activity_records`, `activity_projection_outbox` |

`latestCentralSchemaVersion` in source includes through **20**.

---

## 10. Verification (re-run at assembly and re-verification)

All commands run in the monorepo working tree on tip `53eb525c`; results inspected.  
**Re-verification (2026-07-25T14:08:58Z):** same focused suite re-run on the same tip — **128 tests passed** (counts below unchanged).

### Schema / policy (unit)

```text
pnpm exec vitest run --config vitest.unit.config.ts \
  packages/server/src/__tests__/humanIdentitySchemas.test.ts \
  packages/server/src/__tests__/humanIdentityPolicy.test.ts \
  packages/server/src/__tests__/workAssignmentSchemas.test.ts \
  packages/server/src/__tests__/workAssignmentPolicy.test.ts \
  packages/server/src/__tests__/workAssignmentWorkItemRef.test.ts \
  packages/server/src/__tests__/commentActivitySchemas.test.ts \
  packages/server/src/__tests__/commentActivityPolicy.test.ts \
  packages/server/src/__tests__/commentAttachmentPolicy.test.ts
```

**Result:** 8 files / **59 tests passed**.

### SQLite / HTTP / dispatch / blob / projection (integration + focused)

```text
pnpm exec vitest run --config vitest.integration.config.ts \
  packages/server/src/__tests__/humanIdentityRepository.test.ts \
  packages/server/src/__tests__/workAssignmentRepository.test.ts \
  packages/server/src/__tests__/workAssignmentService.test.ts \
  packages/server/src/__tests__/workAssignmentDispatch.test.ts \
  packages/server/src/__tests__/workAssignmentTempPackage.test.ts \
  packages/server/src/__tests__/commentActivityPersistence.test.ts \
  packages/server/src/__tests__/commentAttachmentHttp.test.ts \
  packages/server/src/__tests__/commentService.test.ts

pnpm exec vitest run \
  packages/server/src/__tests__/humanIdentityHttp.test.ts \
  packages/server/src/__tests__/commentActivityProjection.test.ts \
  packages/server/src/__tests__/lifecycle.test.ts \
  packages/server/src/__tests__/serverComposition.test.ts
```

**Result:**

- Integration batch: 8 files / **52 tests passed** (includes real SQLite concurrency, attachment HTTP isolation, durable dispatch host pin after restart).
- Human HTTP + activity projection: 2 files / **13 tests passed**.
- Lifecycle + composition: 2 files / **4 tests passed**.

**Focused total:** **128 tests passed** across the HC domain surface listed above.

Covered adversarial / race themes include: Host credential on human routes; cross-project membership and digest isolation; invitation double-consume; last-owner protection; device revoke membership fence; assignment CAS losers; dispatch reassignment vs reserved Host; comment revision conflict; activity source idempotency and outbox reconcile.

### Not re-run as HC gate evidence

- Full monorepo `pnpm test` / desktop smoke / VPS live e2e (release/RV scope).
- Live multi-operator Desktop token handoff (not implemented in HC).

---

## 11. Residual risks and defects (honest gaps)

These are **not** silent failures of the domain model. They are incomplete product surfaces or operator hygiene items. No new HC product code was added in this checkpoint to paper over them.

| Gap | Owning surface | Severity | Notes |
| --- | --- | --- | --- |
| No public HTTP for comment create/edit/tombstone/list or activity list | Future transport / desktop bridge (not HC-001–003 acceptance) | Product | Application services exist; only attachments are HTTP-exposed |
| Membership / assignment / remote_run activity not auto-wired into those services | Call sites of `ActivityProjectionService` | Medium | Explicit-call design; projection can lag if callers forget |
| `ACTIVITY_RETENTION_MAX_AGE_MS` soft only | Operator retention | Low | Tombstones intentional; staged attachment cleanup is enforced |
| Host↔project authorization default may treat non-revoked Hosts as authorized until a dedicated binding table exists | Assignment Host port (HC-002) | Medium | Documented in assignment service ports; not a role expansion |
| Desktop secure storage handoff for `deviceToken` | Desktop | Product | Server one-shot return contract documented; renderer must not use cookies/`localStorage` |
| `migrations.ts` size over 40KB hygiene threshold | Server migrations | Hygiene | Pre-existing; grown by v16–v20 |
| Non-blocking naming: `listInvitations` reuses `create_invitation` action matrix | Identity HTTP | Low | Same owner privilege; dedicated list action optional |

**No open HC review feedback.** FE-008 and FE-009 are resolved. No defect was returned to owning Tasks as a checkpoint-blocking failure.

---

## 12. Checkpoint readiness

| Criterion | Status |
| --- | --- |
| HC-001/002/003 final reviews `passed` | yes |
| FE-008 / FE-009 resolved with re-review | yes |
| Minimal roles (`owner`/`member` only); invites never owner | yes |
| Credential kind isolation (human vs Host/operator) | yes |
| Digest-only secret persistence | yes |
| Assignment does not mutate package / claim / run | yes |
| Durable dispatch host selection fingerprint | yes |
| Comment content ACL separate from artifact grants | yes |
| Activity projection-only; no chat/proposal/consensus | yes |
| Removed-concept search clean for HC modules | yes |
| Combined focused tests green on tip | yes |
| Full HTTP surface for comments/activity | **no** (residual) |
| Automatic multi-domain activity wire-up | **no** (residual) |

**Conclusion:** Human collaboration domain is **minimal, project-scoped, auditable, and credential-isolated** at the Server application layer covered by HC-001–003. Checkpoint **passes domain acceptance** with residual product-surface and wire-up gaps listed above — not as unfixed security regressions of the reviewed tasks.
