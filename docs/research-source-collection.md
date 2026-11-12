# Research source collection

Agreement version 3 covers eligible imported source files as well as semantic usage and research content. The agreement is per account. Its stored acceptance is checked before capture; the collector verifies the authenticated account before delivery and records version 3 for that surface. Pending records stay bound to the original account after sign-out, restart or account switch.

## Source boundary

Desktop and the browser sandbox consider `paper.pdf` and files under `sources/` inside a project the researcher opens. Baseline scans skip dot entries and symlinks. The watcher can capture eligible additions and changes; resolved paths must remain within the project. Private, researcher-only and quarantined source paths are excluded. The browser sandbox has the same filtering because it runs the same main process.

For published studies and projects containing private copies, the capture boundary uses path checks and an index of normalized private text. Matching text is withheld before storage. While private material is indexed, opaque or oversized content that cannot be checked under the scoped rules stays local. Outputs under `artifacts/simulations/` or `runs/` of a published study stay local. The private index is a bounded matching check, so it does not establish that a paraphrase or an unindexed copy has been detected.

The separate headless CLI uses the same path redaction and file eligibility checks. It has no private wording index. It refuses projects containing protected source paths, symlinks under the source tree, held wording, or a protocol it cannot read. The same check gates capture and delivery. If a protected state appears during a run, the worker stops capture, cancels requests still in flight, and leaves pending files local. A project-local stop marker prevents automatic retry after restart. A request the server already accepted before cancellation may have been stored. Earlier CLI queues also stay local and require manual recovery.

Hub Studio archives original files already stored under the authenticated workspace. The route verifies workspace access and the current research agreement when its rollout flag is enabled. Studio original-file archival and the browser sandbox's project-file collector are separate paths.

## Byte preservation and verification

Eligible originals are streamed as exact bytes and named by their SHA-256. Original source bytes are not rewritten during collection. A large source uses ordered 4 MiB parts and a manifest carrying the original byte count and hash. An object is reused by hash within an account. Repeated imports within a project reuse the import receipt; a second project can link the same original bytes to its own source event. This private research archive is separate from public community contributions.

The collector submits the version-3 agreement, uploads each needed object and receipt, then submits its event. A failed request leaves data recoverable. Settings → Research data exposes delivery status and the signed-in account export, including local queues and stored originals. See [Research data](research-data.md) for current attribution and release boundaries.

The focused collector and coverage tests use synthetic accounts and mocked network responses. They cover exact multipart round trips, capture without a live token, interrupted delivery, stale or absent agreement, account switches, rejected records, and exports. The application and SQL sources specify owner-scoped access to rows and private objects. A deployed end-to-end check of account isolation, live Storage delivery and export still needs a designated synthetic account and a separate fixture account. This audit did not query participant records or mutate a database.
