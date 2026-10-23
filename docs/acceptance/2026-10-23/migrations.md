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
