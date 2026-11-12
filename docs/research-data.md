# Research data

HumanStudy Hub studies how researchers work with an AI agent. The app asks the signed-in researcher to accept agreement version 3 before using the agent. The Desktop dialog offers one decision for usage, research content, and eligible imported sources. An older agreement does not carry forward. The browser sandbox uses the same application and agreement.

## What the app captures

| Data | Current capture |
| --- | --- |
| Usage | Product actions, timestamps and dwell, settled scroll summaries, final selections, layout changes, and source citation navigation. A click or shortcut records the action it triggers. Typing episodes record counts. Selection anchors can include selected text and page-relative bounds. |
| Conversation | Submitted text and workspace context, assistant messages including interrupted replies, questions and answers, errors, and usage. Workspace context may include a selected passage and open views. |
| Agent execution | Turns, tool names and complete eligible input/output, permissions, durations, statuses, and model usage. |
| Research work | Human Study Program versions, changed `protocol.json` and `study.json`, generated files in `artifacts/`, `exports/` and `package/`, and eligible annotations. The normal file watcher observes changes after they settle. An app save of `program.json` records the exact committed version before a later agent write can replace it. |
| Source material | Original eligible files from `paper.pdf` and `sources/` in opened projects. See [source collection](research-source-collection.md) for the source boundary. |

There is no screen recording, DOM replay, mouse movement stream, or individual typing history. The legacy replay IPC rejects recordings. Existing recording files stay available for historical export. Historical content blobs can still be delivered without sending historical screen recordings.

The collector removes credential-shaped values, email addresses, and absolute paths from eligible text. Paths inside the project become relative. It checks private paths and indexed private wording before persisting captured content. Protected files and matching text are withheld. Eligible long values are stored in full after sanitization. Content over 4 MiB is split into ordered parts and reassembled before UTF-8 decoding or SHA-256 verification.

## Surfaces and attribution

| Surface | Current wiring |
| --- | --- |
| Electron Desktop | Shared capture code writes `surface=desktop` with the OS platform. |
| Browser sandbox at `/try` | The browser sends semantic actions through the same app's preload and main process. The trusted sandbox server sets the client identity before main loads. New v1 rows are `surface=web`, `platform=browser`. New legacy rows keep the runtime platform required by that table and add `metadata.surface=web` and `metadata.client_platform=browser`. Earlier locally queued v1 rows keep their captured labels and are available in the account export. |
| Hub Studio in the web repo | Separate editor and server producers. The server flag `RESEARCH_COLLECTION_V1_ENABLED=1` enables the Studio agreement, v1 interaction delivery, source archival and server outbox. The producer builds conversation, dispatch/result, proposal and committed research versions from server state. These v1 rows identify the web surface. The flag and deployed behavior require deployment verification. [Web contract](https://github.com/HumanStudy-Hub/humanstudy-hub-web/blob/dev/docs/research-data-contract.md) |
| Headless CLI | Uses the same collector and agent adapter with the operator's own account and `surface=headless`. Commands provide action links. UI navigation is inapplicable. The worker refuses private or held wording that it cannot verify. [Headless setup](headless-research.md) |

V1 records use a per-collector session id and capture sequence. A primary `action.invoke` links follow-on events via `action_id` and `caused_by`. Native conversation IDs link messages and tools. Passive dwell and settled scroll summaries can stand alone. Legacy `desktop_events` has its own session id; do not treat its event and sequence stream as v1. The [coverage map](research-coverage-map.json) lists capture points and known gaps. V1 does not synthesize a recovered session end for an earlier process that crashed. Previously queued events remain recoverable.

## Delivery and control

V1 queues locally under `userData/research-v1/<owner-id>/` on Desktop and `userData/research-v1/web/<owner-id>/` in the browser sandbox. After verifying the current account, the collector records the agreement for the same owner and surface. It uploads content objects and receipts before writing the event that references them. The destination is `research_events`, `research_content`, `research_consents` and the private, owner-scoped `research-content` bucket. Legacy events use `desktop_events`; historical blobs and recordings use `desktop-replays`. The legacy uploader retains timestamp-rejected records for local recovery. The web repository includes the migration that permits older offline captures.

Unacknowledged v1 records and content remain local across restarts. Rejected rows retain their original bytes and report a delivery gap. V1 caches may be reclaimed after acknowledgement. There is no age or count pruning of pending v1 content. Withdrawal stops new capture and v1 delivery on this installation. Pending v1 data stays local and available to the same account for export. The legacy withdrawal path discards the pending legacy event queue and clears the legacy local replay cache. Withdrawal does not delete cloud records. Self-service cloud deletion is unavailable; the team handles requests.

Settings → Research data shows delivery status and provides an account export. It includes stored records, content objects and manifests, local queues and available historical data. An incomplete object export fails instead of silently omitting data.

## Verification and release versions

The November 12 audit compared Desktop development commit `78a5a7c` and Hub Studio development commit `be31258`. The latest stable Desktop release was `v0.7.2`; `v0.8.0-beta.1` was a prerelease. Both tags contain the version-3 collector. The browser attribution and headless privacy fixes in this change apply to builds containing this commit. [Desktop releases](https://github.com/HumanStudy-Hub/humanstudy-desktop/releases)

Focused local tests use synthetic events, projects and transport fixtures. They verify consent, operation links, complete large content, owner separation, retries, private filtering, browser labels and the headless guard. They do not establish that the current deployment delivers records or that a particular account's records are complete. Deployment verification needs a designated synthetic account and the real application and database to verify same-account consent, isolation from a second account, object/receipt/event consistency, retry, and export. [Source collection verification](research-source-collection.md)
