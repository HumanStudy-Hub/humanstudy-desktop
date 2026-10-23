# Research source collection — agreement version 3

The owner approved expanded source collection on 2026-10-22. This branch is stacked on desktop
PR #26; it does not resolve that PR's separate build-completion/save/readiness findings or ship a
release. Web schema/API changes must be reviewed and deployed before enabling remote delivery.

- Agreement 3 replaces the old promise never to upload papers. Existing users must agree again.
  Old agreements are not migrated. Source capture stays disabled before renewed agreement.
- Only `paper.pdf` and `sources/` in explicitly opened projects are considered. No disk-wide scan,
  mouse movement, individual keystrokes, screens/DOM or other-app capture is added.
- `research-collector.ts` is Electron-free. Original bytes are streamed into private 4 MiB parts,
  hashed with SHA-256, and durably queued in `userData/research-v1/<owner-id>/`. An oversized source
  uses an ordered manifest. The paper itself is not rewritten, summarized or truncated.
- The account's encrypted stored session provides a local owner ID while offline; uploads use a
  fresh token and verify the actual Supabase user. Account changes never reattribute an old queue.
- Delivery waits for content objects, their receipts, and the event acknowledgement. Failed
  uploads remain locally queued with no age/count pruning. Duplicate imports within a project
  reuse a receipt; identical content in another project reuses private storage by hash.
- Source state is visible in Settings → Research data. The existing account export includes new
  research rows, consent records, source objects/manifests and locally pending records. Export
  stays available without accepting expanded collection. No incomplete object export is silently
  reported as complete. Confirmed local object caches can be removed; undelivered bytes cannot.
- `research-contract.ts` is vendored verbatim from web `lib/research-data/contract.ts`. Update and
  version that canonical file first, then copy it and this collector into the headless branch.

The 30-day legacy offline-policy migration is approved but not applied to the shared database.
The uploader waits safely if the new schema is unavailable. An actual source upload requires a
`research_consents` version-3 row for the same account and surface.

Remaining issue #27 work includes complete v1 adaptation of existing interaction/conversation/tool
events, causality IDs across all surfaces, interruption coverage and the cross-surface coverage map.
This branch adds source collection; it does not claim that every legacy event already uses v1.

Validation: offline tests cover consent gating, expired/offline sessions and restart, per-owner
deduplication, exact multi-part round trips, interrupted upload/account changes, corruption, and
complete source export without renewed agreement. Real Supabase Storage, Windows and packaged
application acceptance remain separate rollout checks. No shared database changes or source
uploads to the production account were performed during implementation.
