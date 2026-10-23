# T12 — Supabase migration history + research_server_outbox (2026-10-22 PT)

Project `zigbuogyerivbnxtnjjw` (shared dev/production). Evidence: [migrations.json](migrations.json).
No destructive operation, no `supabase db push`, no user data touched.

## History reconciliation
- Before: 13 rows. `20261012180000_desktop_events_owner_default` and
  `20261013120000_desktop_data_no_user_delete` were missing; five studio files used other
  timestamps than live; `20261014212248_desktop_support_requests` was live but only on the
  unmerged `codex/beta-help-feedback` branch.
- Effects verified live, read-only: both owner_id defaults are `auth.uid()`; the three delete
  policies are absent; support_requests exists with RLS + own insert/select policies; the
  recorded statements match the files (comments/whitespace aside).
- Writes: inserted the two missing history rows (statements = file).
- Repo: web `claude/research-t08-server` 6527f9b renames the five files to their live versions and
  adds the support_requests file, byte-identical to the live statements. 16 files == 16 history rows.
  `origin/main` still has the old names until PR #26 merges, so never `db push` from main.

## Outbox migration `20261023120000_research_server_outbox`
- Review result: additive, RLS owner-only, no SECURITY DEFINER, fixed search_path, anon gets
  nothing, CAS delegates to the unchanged `studio_cas_workspace`. Prod saves are unaffected.
  The file did not need changes.
- Rolled-back run (BEGIN; migration; tests/research-server-outbox.sql; ROLLBACK) passed. A
  negative control confirmed that failures surface.
- Applied in one transaction along with its history row, under the filename's version.
- Post-apply: the before/after catalog diff removed nothing, and every added object belongs to the
  outbox. 0 rows. Production `/` and `/api/desktop/config` both return 200.
- Open code finding (T08, before the cron is enabled): the service-mode drain only re-checks web
  v3 consent. It should also force surface=web and research_session_id=outbox id, and enforce
  the research_events/content policy predicates that the service role bypasses.

## Tighten migration `20261023140000_research_server_outbox_tighten` (T08 follow-up)
- Source: web `claude/research-t08-server` 9ba6f11, md5 78226fe7a02ed6414ce94e037b460b2b, applied unchanged.
- Review result: one `alter policy research_server_outbox_insert ... with check`, nothing else. The
  roles stay `authenticated` and no other policy, table, grant, function or trigger changes. The new
  check requires the owner to be the caller, the project (when set) to be a workspace the caller
  owns, `event_count`/`content_count` to equal the payload lengths, and every event to be an object
  with surface=web and research_session_id=row id that names no other owner.
- RPC compatibility: `studio_cas_workspace_research` (security invoker) inserts as the user. Web
  rows come from `outboxRow` + `buildServerBatch`: id = session id, project_id = the CAS'd
  workspace id (`planBatches(ctx, id, ...)`), counts = array lengths, events surface 'web' with
  that session id and no owner_id. All of them satisfy the new check. A violation inside the RPC
  is caught by its subtransaction, so the save still commits and `outbox_stored=false`.
- Rolled-back trial (BEGIN; migration; tests/research-server-outbox.sql; tighten tests; ROLLBACK)
  passed. The repo test needed an adjustment because its synthetic payloads have empty `events`
  with `event_count` 3/2, which the new policy rejects. In the trial they were built with matching
  web events of the batch session (the test logic is unchanged). Tighten tests: a producer-shaped
  RPC batch (2 events + 1 content) is stored; direct inserts with own owner, null project or
  explicit own event owner_id are accepted; nine forged direct inserts are denied with 42501
  (other owner, another user's project, unknown project, desktop surface, wrong session, event
  naming another owner, event_count mismatch, content_count mismatch, non-object event); a forged
  RPC batch and a cross-project RPC batch commit the save but store nothing. Negative control:
  the same script without the migration fails ("forged row accepted: other user project").
- Applied in one transaction together with history row `20261023140000 research_server_outbox_tighten`
  (statements = file). That makes 17 history rows.
- Post-apply: the catalog diff shows exactly one policy changed (research_server_outbox_insert
  with_check) and 0 changes to grants, column grants, functions, triggers and RLS. Outbox rows
  were 0 before and 0 after. The rolled-back tests pass against the live policy. Production `/`
  and `/api/desktop/config` return 200.
- Follow-up (web repo): `tests/research-server-outbox.sql` still uses count-mismatched empty
  payloads, so it now fails as committed. Update `pg_temp.batch` and section 8 to send matching
  web events of the batch session, and add the forged-row cases.
