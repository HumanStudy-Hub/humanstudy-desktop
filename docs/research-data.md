# Research data: what is collected and where it goes

HumanStudy Hub Desktop is a research instrument: the study is how social scientists work with an
AI agent. Using the agent requires consent (the dialog is in `ResearchData.tsx`). Two switches:

| Consent | Allows |
|---|---|
| `usage` | Lifecycle, UI actions, timings, agent-turn metadata (`desktop_events`) |
| `usage` **and** `content` | Everything below that carries the researcher's own work: transcript text, `program.json` versions, written files |

With either switch off, the matching data is neither captured nor queued. Withdrawing consent
discards pending events and deletes pending replay files on disk. Every payload passes the
sanitizer first: emails, key/token-shaped strings and absolute paths are replaced
(`[email]`, `[secret]`, `[path]`; project paths become project-relative).

## One session id

`telemetry.sessionId` (a UUID per app run) links interaction events, conversations and project
versions. `app.session_start` reports `collection_mode: interaction-events`. Historical replay
records from earlier versions keep their original session ids for export only.

## Collected

### 1. No session recording (changed 2026-10-15)
The renderer does not load rrweb, install DOM mutation observers, capture page snapshots,
record mouse trajectories/coordinates, or record continuous scrolling and keystrokes.
Only explicit application actions and timings are collected. Input episodes report a count,
not drafts or individual keys; submitted messages belong to the separately consented transcript.
The legacy replay IPC always returns false. Pending DOM recordings from previous versions
remain local and are excluded from automatic upload; this change does not delete historical
research data. Large transcript/artifact blobs still upload in full, without truncation.

### 2. Semantic events (`desktop_events`), usage consent
Existing names are unchanged. Added: `tab.close`, `tab.switch` (`durationMs` = dwell of the tab
that was left), `file.open`, `explorer.toggle`, `study.section_toggle`, `selection.change` (ids),
`source.page` (page shown, dwell of the previous page), `composer.typing_start`,
`composer.send` (chars, attachments), `permission.reply` (type, reply), `thread.switch`,
`model.change`, `shortcut` (modifier combos only). Pane fold/unfold, explorer show/hide and
thread switches carry `durationMs` of the state they ended. No sampling.
Historical unuploaded replay files remain on disk for export, without automatic upload.

### 3. Agent transcript (`conversation.*`), content consent
One event per final message part, with `thread_id`, `message_id`, `part` (index) in `metadata`:

- `conversation.user`, `conversation.assistant`: `text`
- `conversation.tool` (`target` = tool): `state`, `detail`, `input` (JSON), `output`
- `conversation.permission` (`target` = type): `resolved`, `detail`, `patterns`
- `conversation.error`, `conversation.usage` (tokens, cost per message)

Each user turn can also carry `workspace` (JSON): active tab, selected study id/title,
open resource tabs, current file and unsaved status, visible source page and the cited
passage, and whether the panels are open. It is saved separately on the thread message,
included in recovered agent context, and hidden from the ordinary chat bubble. Queued
messages keep their original context when the user later switches tabs. UI focus is not
simulation approval or evidence that a study fact is correct.

The kernel and recovered thread context preserve complete tool input/output and messages. Long values
use `<key>_blob` rather than a clipped inline prefix. Metadata exceeding the event row limit uses
`metadata_blob`; the complete object remains in the referenced blob.

### 4. Project snapshots, content consent
- `project.program_version`: on every `program.json` change (and once when the project opens,
  `initial: true`): `version`, `by` (`agent` | `human` | `open`), `bytes`, `hash`, `diff`
  (`sections.<nodes|steps|...>.{added,removed,changed}` ids, `keys`), `blob` = full JSON
  without a recording size cutoff.
- `project.file_written`: files created or changed under `artifacts/`, `exports/`, `package/`:
  path (`target`), `size`, `ext`, `by`, and for text files the complete content as a `blob`.
  `paper.pdf` and anything under `sources/` are never sent.

## Storage layout

Bucket `desktop-replays` (legacy name, private; owner-scoped; self-service deletion disabled):

```
<owner_id>/<session_id>/<seq>.json.gz         historical rrweb events; no new capture/upload
<owner_id>/<session_id>/blobs/<uuid>.gz       large payloads referenced from event metadata
```

Table `desktop_replay_chunks` (`id, owner_id, session_id, seq, started_at, ended_at, bytes, path,
window_id, app_version, created_at`; RLS: historical own rows; no self-service delete) has one row per rrweb
chunk, not per blob. Migration: `supabase/migrations/20261012150000_desktop_replay.sql` in the
web repo.

Local staging: `userData/replay/<session_id>/<seq>.json.gz` (+ `<seq>.meta.json`) and
`blobs/<uuid>.gz`. A file is deleted only after the server confirmed it; uploads retry with
exponential backoff (20 s up to 10 min). Disk use above 200 MB is a warning; files are not deleted
to meet that threshold. Pending events are retained across restarts without age or count pruning.
The live server still rejects event timestamps older than 30 days until the owner approves the
`desktop_events_allow_offline_capture` migration; rejected records remain locally recoverable.

## Control

- Self-service deletion is disabled during the beta (2026-10-13): no UI or IPC, and the server has
  no delete policy on `desktop_events`, `desktop_replay_chunks` or the `desktop-replays` bucket
  (web migration `20261013120000`). Deletion requests go to the team (service role).
- `telemetry.exportMyData()` opens a save dialog and writes a zip: `events.json`, `threads/` (of
  projects opened in this run), `replay/index.json` + `replay/<session>/<seq>.json.gz` + blobs,
  and `replay-unsent/` (not yet uploaded). Resolves with the path, `null` if cancelled.

## Complete large content

A payload above 4 MiB UTF-8 is stored as ordered gzip parts plus a gzipped JSON manifest:
`{ "format": "humanstudy-content-parts-v1", "encoding": "utf8", "bytes": N, "parts": [...] }`.
Part paths are relative to the same session directory. Gunzip each part, concatenate the bytes
in manifest order, then decode as UTF-8 (a Unicode character may cross the byte boundary).
This is splitting, not shortening. ZIP exports include manifests and parts.

The Simulation tab records `simulation.view` (once per opening: package built, runnable, number
of runs and conditions), `simulation.build` ("Build the study first"), `simulation.run` (AI
participants per condition, number of conditions, model), `simulation.stop` (participants done of
planned) and `simulation.result_open` (from the tab or the run list; whether it was the shipped
example). No study text is attached. The researcher's confirmation is also part of the
conversation, with the selected study, full program SHA-256, the five section-12 fields and the
plan (`perCondition`, conditions, model). Simulation assessments are implementation judgments,
not observations of people.

Native OpenCode `question` interactions are stored as `question` parts in each local thread,
with complete prompt text, offered options and exact selected/custom answers. With content
collection enabled, `conversation.question` captures both the pending request and its
answered/dismissed state, linked by question, thread and message ids. Interaction-only
`question.reply`/`question.reject` events carry ids/counts, not answer text. Dismissal is not
consent; stopped turns explicitly clear pending questions in the native server.
