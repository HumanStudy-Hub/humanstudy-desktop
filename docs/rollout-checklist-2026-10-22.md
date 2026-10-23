# Unified collection and application rollout

Owner authorization (2026-10-22): integrate collection into the actual applications, complete
desktop/web/headless interaction and agent capture, validate the real database and packaged
application, migrate the database. Previously reviewed build/save/readiness issues are tracked separately. On 2026-10-22 the owner separately authorized fixing/testing them; see the tester follow-up below.
The owner requests one maintained TODO. This file is the canonical execution checklist; GitHub
tracking links and evidence are updated as work progresses.

Status: `[ ]` not done, `[~]` in progress, `[x]` verified. A draft PR or passing mock is not live
acceptance. No continuous pointer movement, individual keystrokes, screen/DOM recording, silent
truncation or fabricated study information. Preserve original source traceability.

## Execution

- [~] T01 — Audit current PRs, deployment linkage, database schema and migration history.
  Evidence: desktop #26/#28 and web #25 remain open at their reviewed revisions. Shared project
  is healthy; the approved v1 and offline-policy migrations were applied. Existing history
  discrepancies were audited against actual defaults/policies; do not blindly db push.
  Integration (2026-10-22): #26 + #31 + #28 combined on `claude/integration-0.6.7-collection`
  (draft PR #32); one textual conflict (TODO.md) and one semantic fix — program versions are now
  captured from the exact bytes committed under #31's save lock, attributed by content hash.
- [x] T02 — Tracking issue: https://github.com/HumanStudy-Hub/humanstudy-desktop/issues/30; linked from repository TODO.
- [~] T06 — Shared durable event/content collector: full text, content references, monotonic
  sequence/checkpoints, account ownership, deduplication, rejection quarantine and delivery state.
- [~] T07 — Desktop: route semantic clicks/shortcuts, navigation/dwell, final selections and
  layout, full conversation/partial output, questions, permissions, tool input/output/timing,
  reported usage, program/artifact versions and source inputs into the new contract.
- [~] T08 — Web: durable browser queue and semantic actions; server-owned conversation/tool,
  program/artifact capture; source linkage and agreement enforcement. Remove count/age drops,
  invalid-batch drops and unsafe cross-tab queue adoption.
- [~] T09 — Headless: use the same collector/agent adapter; capture commands/conversations,
  questions/permissions, tools, partial failures, usage and final artifacts under the actual
  collaborator identity. UI-only actions are explicitly not applicable.
  Integration (2026-10-22): #29 (+#10/#11) rebased by merge onto the 0.6.7 integration on
  `claude/headless-on-0.6.7` (draft PR #33). The worker now runs the same kernel (#26 liveness and
  request transport), pack, save lock, completion certificate and collector as desktop; one tracked
  copy of the collector/agent/contract, asserted by `app/scripts/headless-parity.test.mjs`.
  Offline only: no real worker run under a personal account yet.
- [ ] T10 — Cross-surface action/parent causality, coverage map and no-double-counting checks.
- [x] T11 — Real database/Storage acceptance with isolated synthetic accounts: roles/RLS, other-account denial, consent,
  original file round trip, duplicate/restart/interruption and verifier behavior.
  Evidence: [service](acceptance/2026-10-22/service.json), [web](acceptance/2026-10-22/web.json).
  SQL acceptance ran in a rolled-back transaction on real PostgreSQL; HTTP tests used temporary
  synthetic accounts. Web bulk-insert key mismatch was found and fixed during this acceptance.
- [~] T12 — Reconcile migration history and apply reviewed additive schema/offline policy to
  shared Supabase. User has authorized migration; preserve existing records and legacy clients.
- [ ] T13 — Deploy/configure actual web backend with staged flag; verify agreement, source
  archival, signed-in identity and protected integrity job against the real database.
- [~] T14 — Package Mac test build; click through import/automatic build, source comparison,
  chat/tools, saved edits, offline/restart, data upload and account export.
  Partial evidence: [bundle](acceptance/2026-10-22/bundle.json), packaged ASAR main/preload/renderer
  loaded in isolated Electron, actual project directory and Study/PDF comparison opened, mock
  chat/tools uploaded to real Supabase and account ZIP exported. This is not an installed-app,
  real-model, update or signed/notarized-installer acceptance.
- [ ] T15 — Windows acceptance on a real Windows environment; record a blocker if unavailable,
  never count simulated platform flags as real-machine acceptance.
- [ ] T16 — End-to-end real-paper hosted build; verify scientific coverage, explicit missing
  items, saved artifacts and data delivery. Record model, version, stop criterion and usage.
- [ ] T17 — Review final diffs and test evidence; obtain owner approval for merge/release when
  concrete installers and changes are reviewable. Do not push release tags before notarization.

## Starting foundations (prior PRs)

- Web #25: agreement 3, pointer-removal hotfix, source archive, schema, integrity verifier,
  hosted-key identity endpoint and rollout flag.
- Desktop #28 (on #26): renewed consent, per-owner source queue/dedup, source export.
- Desktop #29 (on #11): personal headless account and source queue.
- Previous offline results: desktop 147, web 220, headless 18 tests passed. These do not satisfy
  T11–T16. The #26 build/save/readiness follow-up is tracked separately below; PR #31 now contains tested code fixes, without release acceptance.

## Blockers and decisions

Supabase rejected creation of an isolated branch: the current plan does not support branching.
No branch was created and no paid upgrade was requested. Validate the migration with rollback
checks, then use isolated synthetic accounts for real Storage/RLS acceptance after the approved
additive migration. Windows machine access and packaged-app permissions remain to be verified.

## Progress log

- 2026-10-22: started execution; read-only shared-database audit confirms v1 schema absent and
  history mismatch. Requested an isolated Supabase acceptance branch through its cost-aware tool.
- 2026-10-22: integration branches for #26/#31/#28 (PR #32) and headless #29 on top (PR #33). Offline:
  171/171 and 192/192 desktop tests, 17/17 managed-Python pack tests, 7/7 headless conversion tests,
  both TypeScript configs, production build and diff checks pass. Not merged; T14–T16 still open.

## Separate product backlog (outside this collection rollout)

- [x] T03 — Code and regressions: independent schema/coverage validation per identified study, explicit missing outcomes allowed, SHA-256 validation certificates; stale shell writes/reopen invalidate completion. PR #31; real-model/installed acceptance stays open in T14–T16.
- [x] T04 — Code and regressions: preserve confirmed researcher fields/rules, retain full conflict proposals with review issues, shared app/Python lock and compare/save; actual subprocess races pass. PR #31. Arbitrary external writers do not acquire this lock; installed/Windows acceptance remains open.
- [x] T05 — Code and regressions: unread resources fail closed; full large-file checks in main process, current program/selected study/task bindings checked, unknown project and stale approval rejected. PR #31; real adapter smoke and installed acceptance remain required.

## Current acceptance and remaining work

- Database: migrations `20261022223132_research_data_contract_v1` and
  `20261022223142_desktop_events_allow_offline_capture` applied to the shared project. No legacy
  records were rewritten. Applied migration filenames now match the generated live versions.
- Regression: desktop 154 tests (46 files, local-network fixture permissions, concurrency 2),
  web 220 tests, headless selected suite 25 tests; TypeScript and production builds pass.
- Desktop/headless share the exact collector and kernel adapter. Full long text, parallel tool
  ids, interrupted output, questions/permissions, usage, source and generated files are wired.
  Cross-surface causality/one-primary-action coverage remains open (T10).
- Web UI actions now target v1 when enabled. Queue count/age pruning and whole-batch drops were
  removed; independently stored event ids avoid destructive cross-tab adoption. Storage quota
  failure is surfaced, but IndexedDB expansion and full server chat/tool/artifact migration are
  still open. Legacy scientific snapshots remain durable in `studio_research_history`.
- The live production web flag has not been enabled. The local production build passed actual
  agreement, sample original-file archival, mixed UI-event retry and protected verifier tests.
  Enabling production collection before T08 is finished would create an incomplete dataset.
- Synthetic test accounts/objects are removed after evidence capture; no emails were sent.
- Separate product findings (T03–T05) now have code/regression fixes in PR #31, authorized after the collection round; they have not been merged or released. The old Knobe fixture displays formatting
  issues; the bundle acceptance verifies rendering and collection, not scientific completeness.

### Next execution order

1. Complete T08: durable browser storage beyond localStorage and a server outbox for committed
   messages/program/artifacts; capture actual workflow tool events at their producer.
2. Complete T10: one primary action, message/tool/native identities, action/parent linkage and
   explicit coverage checks across all surfaces.
3. Finish old migration-history reconciliation, deploy/configure preview, repeat acceptance.
4. Real-model paper build, installed Mac walkthrough and real Windows machine acceptance.
5. Present concrete changes/installers for the owner's merge/release decision.

- Final collector check: slow network delivery does not block new capture persistence; quarantined records remain visible after restart. Real Storage acknowledgement-loss recovery passed on the final collector.

## Tester reliability follow-up (separately authorized)

- [PR #31](https://github.com/HumanStudy-Hub/humanstudy-desktop/pull/31), branch
  `codex/tester-reliability-fixes`, commit `ffbbb23`, stacked on combined tester PR #26.
- 154/154 offline desktop regressions, 17/17 managed Python tests, main/renderer TypeScript,
  production build and diff checks pass. Electron/React harnesses, real Python concurrent saves,
  omitted studies, current hashes, helper upgrades and valid/invalid large resources are covered.
- Detailed evidence: `docs/tester-reliability-2026-10-22.md` on the fix branch.
- No merge, release, installer publication or database change. T14 installed Mac walkthrough,
  T15 actual Windows and T16 hosted Haiku paper build remain open. Automated tests are not those acceptances.
