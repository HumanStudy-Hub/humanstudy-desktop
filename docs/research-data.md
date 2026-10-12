# Research data: what is collected and where it goes

HumanStudy Hub Desktop is a research instrument: the study is how social scientists work with an
AI agent. Using the agent requires consent (the dialog is in `ResearchData.tsx`). Two switches:

| Consent | Allows |
|---|---|
| `usage` | Lifecycle, UI actions, timings, agent-turn metadata (`desktop_events`) |
| `usage` **and** `content` | Everything below that carries the researcher's own work: DOM replay, transcript text, `program.json` versions, written files |

With either switch off, the matching data is neither captured nor queued. Withdrawing consent
discards pending events and deletes pending replay files on disk. Every payload passes the
sanitizer first: emails, key/token-shaped strings and absolute paths are replaced
(`[email]`, `[secret]`, `[path]`; project paths become project-relative).

## One session id

`telemetry.sessionId` (a UUID per app run) is the `session_id` of every `desktop_events` row, the
`session_id` of every `desktop_replay_chunks` row, and the `replay_session_id` of
`app.session_start`. A session is reconstructed from: the events timeline, the rrweb chunks
(ordered by `seq`, `window_id` tells windows apart), the `conversation.*` events and the
`project.program_version` events, all filtered by `session_id`.

## Collected

### 1. DOM replay (rrweb), content consent
`renderer/replay.ts` records the whole window (Home and project workspaces): DOM mutations, mouse
moves, clicks, scrolls, typed input, text selections, viewport size. A full snapshot is taken
every 10 minutes so a replay can start from a later chunk. Chunks are cut every 10 s or 500 KB,
gzipped in the renderer and sent to main (`telemetry.replayChunk`).

Not recorded: password inputs and the invitation-code input are masked (`input[type=password]`,
`input[name=code]`, `[data-private]`); `<canvas>` (the PDF pages) is blocked.
Replay chunks are binary, so the sanitizer cannot rewrite them: whatever is visible on screen
(for example the account e-mail in Settings) is in the recording.

### 2. Semantic events (`desktop_events`), usage consent
Existing names are unchanged. Added: `tab.close`, `tab.switch` (`durationMs` = dwell of the tab
that was left), `file.open`, `explorer.toggle`, `study.section_toggle`, `selection.change` (ids),
`source.page` (page shown, dwell of the previous page), `composer.typing_start`,
`composer.send` (chars, attachments), `permission.reply` (type, reply), `thread.switch`,
`model.change`, `shortcut` (modifier combos only). Pane fold/unfold, explorer show/hide and
thread switches carry `durationMs` of the state they ended. No sampling.
`replay.dropped` reports replay files discarded for the disk cap or a server rejection.

### 3. Agent transcript (`conversation.*`), content consent
One event per final message part, with `thread_id`, `message_id`, `part` (index) in `metadata`:

- `conversation.user`, `conversation.assistant`: `text`
- `conversation.tool` (`target` = tool): `state`, `detail`, `input` (JSON), `output`
- `conversation.permission` (`target` = type): `resolved`, `detail`, `patterns`
- `conversation.error`, `conversation.usage` (tokens, cost per message)

The kernel truncates single values above 20 KB with a marker. Values too big for the 16 KB event
limit keep a prefix inline plus `<key>_blob` pointing at the full text (see Blobs).

### 4. Project snapshots, content consent
- `project.program_version`: on every `program.json` change (and once when the project opens,
  `initial: true`): `version`, `by` (`agent` | `human` | `open`), `bytes`, `hash`, `diff`
  (`sections.<nodes|steps|...>.{added,removed,changed}` ids, `keys`), `blob` = full JSON
  (not stored above 500 KB: `oversize: true`).
- `project.file_written`: files created or changed under `artifacts/`, `exports/`, `package/`:
  path (`target`), `size`, `ext`, `by`, and for text files up to 200 KB the content as a `blob`.
  `paper.pdf` and anything under `sources/` are never sent.

## Storage layout

Bucket `desktop-replays` (private; policies: an owner reads/writes/deletes only `<owner_id>/...`):

```
<owner_id>/<session_id>/<seq>.json.gz         rrweb events (JSON array), gzip
<owner_id>/<session_id>/blobs/<uuid>.gz       large payloads referenced from event metadata
```

Table `desktop_replay_chunks` (`id, owner_id, session_id, seq, started_at, ended_at, bytes, path,
window_id, app_version, created_at`; RLS: own rows insert/select/delete) has one row per rrweb
chunk, not per blob. Migration: `supabase/migrations/20261012150000_desktop_replay.sql` in the
web repo.

Local staging: `userData/replay/<session_id>/<seq>.json.gz` (+ `<seq>.meta.json`) and
`blobs/<uuid>.gz`. A file is deleted only after the server confirmed it; uploads retry with
exponential backoff (20 s up to 10 min); disk use is capped at 200 MB, the oldest files go first
and a `replay.dropped` event is recorded.

## Control

- `telemetry.deleteMyData()` deletes the user's `desktop_events` and `desktop_replay_chunks` rows,
  every object under `<owner_id>/` in the bucket, and the local replay files.
- `telemetry.exportMyData()` opens a save dialog and writes a zip: `events.json`, `threads/` (of
  projects opened in this run), `replay/index.json` + `replay/<session>/<seq>.json.gz` + blobs,
  and `replay-unsent/` (not yet uploaded). Resolves with the path, `null` if cancelled.
