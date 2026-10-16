> **Start here (2026-10-15):** `docs/handoff-2026-10-15.md` — current state, P0 CPU runaway, 0.6.1 release steps.

# HumanStudy Hub desktop · backlog

Feature parity target: the Codex / Claude Code desktop apps, for social scientists. Each item
names its owner wave so several agents can work without touching the same files.
Status: `[ ]` open · `[~]` in progress · `[x]` done. Keep this file current in every PR.

## Next · 2026-10-13 researcher dogfood

Detailed plan: [next-stage-plan-2026-10-13.md](docs/next-stage-plan-2026-10-13.md).

- [x] Restore resizable Human Program/source comparison; citations keep extraction visible.
- [x] Auto on by default with a chat toggle; apply to existing sessions, use one-call grants.
- [x] Research-oriented activity messages; full technical details stay expandable.
- [ ] Real-paper owner dogfood, PDF zoom/text annotations/quote highlights, sample attachment repair,
      and collaborator dev-backend access before sharing. See detailed acceptance criteria.

## Next · from the 2026-10-12 review (agent-first: no new buttons/tabs)

- [x] Server: desktop_events owner_id default (every event was rejected by RLS). Web dev 1958777.
- [x] Beta smoke fixes (11 items), research runtime K3, researcher UX (Study/Paper + Claude-style artifacts, files hidden, plain tool rows, zh UI), missing = amber. v0.4.0.
- [ ] Production: merge web dev → main + prod env SUPABASE_SERVICE_ROLE_KEY, COMMUNITY_BOT_LOGIN — only when the owner says (still testing on dev).
- [ ] Paper view: citation click jumps to the page **and highlights the quote** (pdf.js text layer); selecting text in the paper shows which items cite it. Display only.
- [ ] build skill: verify every evidence quote against `hs-pdf pages` output; flag mismatches as issues (agent, not UI).
- [ ] simulate skill: label output "Simulation — not human data", report human vs simulated side by side with spread, overestimation caveat, memorisation warning, run manifest (agent writes it into the report).
- [ ] Skills check: APA tables / prereg (OSF, AsPredicted) / .docx / .qsf / .sav are reachable by asking the agent (runtime has the libs); no UI.
- [ ] IRB-ready data statement (what is collected, where, not used to train third-party models, export/delete) for the agreement + website.
- [ ] Windows real-machine test (kernel + runtime).
- [ ] Remaining English chrome: Research data settings, native menu, kernel status lines.

## P0 · must work before anyone outside the team uses it

- [~] **Login front and center** — Sign in / email in the Home title bar; sign-in card in the chat
      when there is no model access. (wave R1, renderer)
- [x] **Model error without a key** — never force `openrouter/...` on opencode when no key or
      account exists. Superseded by H1: no own-key path in the product; signed-out users get a sign-in card and no session starts. (ca1438f)
- [x] **Bundled agent kernel** — the pinned HumanStudy opencode (`hs-v1.19.0`) downloads into userData
      on first run (SHA256SUMS.txt check, resume, retry, `kernel.install` IPC); no fallback to a system
      opencode; kernel runs with its own XDG dirs under userData/kernel. (M1, K2)
- [x] **opencode HumanStudy edition** — fork https://github.com/HumanStudy-Hub/opencode (branch
      `humanstudy`, releases `hs-v*`): bakes in the `humanstudy` provider, models and safe defaults;
      the app only exports `HUMANSTUDY_DESKTOP_KEY` / `HUMANSTUDY_HOSTED_BASEURL` / `HUMANSTUDY_SERVER_BYPASS`. (K2)
- [x] **Permission prompts** — opencode `permission.asked` → Allow once / Allow for this project /
      Deny in the chat; honour Settings → Default permission. (wave M2 main, R2 renderer)
      M2 done: `permission` KernelEvent, `kernel.reply(sessionId, permissionId, once|always|reject)`,
      auto-approve inside the project when Settings is "project". R3: inline card (icon, command/path/URL,
      diff, Allow once / for this project / Deny, ⌘⏎ and Esc), collapses to one line.
- [x] **Conversation history** — threads per project, restored when a project is reopened; new
      thread button; thread list in the agent pane. (wave M2 main, R2 renderer)
      M2 done: `window.humanstudy.threads.{list,get,create,resume,rename,delete,onChanged}`, stored in
      `<project>/.humanstudy/threads/`. R3: newest thread resumes on open, History menu (switch, New thread
      ⌘⇧T, rename by double-click, delete), "Resumed" note.
- [x] **Version everywhere** — version in Home footer and title bar tooltip, Settings → About with
      "Check for updates" and the changelog link; `npm version` bump to 0.2.0 at release. (R2)
- [x] **Real end-to-end run** — dev server → test account → promo code → desktop key → Sonnet 5.5
      built Knobe (2003) through the hosted proxy: program.json (3 studies, 31 nodes, 13 steps,
      25 evidence, 14 issues) + eight-file package, `check_package.py` passes, readiness
      "blocked: question wording not printed in the paper" (correct). Fixed on the way: scratch
      files must stay in `.humanstudy/tmp`, PROJECT_FORMAT.md is installed, checker resolves
      relative paths. Simulation not yet run (needs the researcher's decisions). (2026-10-12)
- [x] **Research data: full replay** — with usage + conversation consent the app records everything
      needed to replay a session: rrweb DOM chunks (10 s / 500 KB, gzip) uploaded to Storage bucket
      `desktop-replays`, semantic UI events with dwell times, the complete agent transcript (tool
      input/output, permissions, usage), `program.json` versions with id diffs and agent-written
      files. One session id ties them together; Delete my data and `telemetry.exportMyData()` cover
      all of it. Migration `20261012150000_desktop_replay.sql` (web repo) must be applied before the
      first upload. See `docs/research-data.md`. (wave H2)
- [x] **Research runtime (K3)** — clean Macs/PCs have no Python or poppler (`python3` even opens the Xcode
      installer). First run now also installs a private runtime beside the kernel into
      `userData/runtime/<version>/`: python-build-standalone CPython 3.12.15 (pinned URL + SHA-256) and a
      hash-pinned wheel set (`pack/runtime/requirements.lock`, `pip --require-hashes --only-binary :all:`;
      numpy scipy pandas statsmodels matplotlib pingouin pypdf pdfplumber openpyxl python-docx pyreadstat
      jinja2 jsonschema). `bin/` (python, python3, pip, `pdftotext`/`pdfinfo` shims, `hs-pdf pages`) is first
      on the kernel PATH; a stub bin that fails loudly replaces it while the runtime is missing, so nothing
      falls through to the system Python. `humanstudy_llm` (`llm`, `chat`, `llm_many`) gives simulations
      hosted-model access with retries, a concurrency cap and `.humanstudy/tmp/llm-usage.jsonl`. Kernel +
      runtime share one `kernel.install` progress stream (`phase`, `runtimeVersion` added, backward
      compatible). See `docs/runtime.md`. Open: Windows untested on real hardware; Intel-Mac wheel gaps on
      new releases (run `pack/runtime/relock.sh`); OCR for scanned PDFs; disk use (~0.55 GB). (wave K3)
- [x] **Notarized Mac release** — 0.6.1 Apple Silicon/Intel installers signed, notarized and stapled; public automatic-update channel published. Real arm64 0.6.0→0.6.1 download, quit-to-install and reopening passed. Windows real-device acceptance remains open. See docs/verification/auto-update-2026-10-15.md.

- [x] **Hosted-only product (H1)** — no API keys, no provider choice (C17 "own keys" is not a product
      feature; `HUMANSTUDY_DEV_KEYS=1` keeps a hidden developer path). Sign in + invitation code unlocks
      the agent; one mandatory Research data agreement (consent v2, usage + content together); "Not now"
      locks the composer; no kernel session before hosted access and agreement. Projects folder
      "Change…" in Settings and "Choose folder…" on Home. Still open: server/main-side capture of agent
      files and UI actions promised by the agreement; a paid no-collection tier; gate `kernel.startSession`
      in the main process too.

## P1 · Codex-level agent pane

- [x] **Markdown rendering** of agent replies (headings, lists, tables, code with copy button,
      links open externally). (R2)
- [x] **Tool calls as diffs** — unified diffs coloured and collapsible, file name as summary, "Show in
      Study" for program.json. (R3) Still open: summarising program.json changes as changed item titles.
- [~] **Model picker in the composer** (hosted list only) and per-turn model;
      recommended default Sonnet 5.5, Haiku 5.5 for quick questions. (R2)
- [x] **Queue vs interrupt** while the agent runs (the setting exists; implement both). (R2)
- [x] **Attach files** — drag a PDF/CSV/image into the chat or project; `@file` mentions from the
      Program tree. (R2)
- [x] **Finished notification** — macOS/Windows notification and dock badge when a turn ends
      while the window is in the background. (M1)
- [x] **Native menu + shortcuts** — File (New project ⌘N, Open ⌘O, Close), Edit, View (panes
      ⌘1/⌘2/⌘3, zoom), Help (docs, release notes, report a problem). (M1)
- [x] **Token/cost footer** — per-turn tokens and cost from the hosted proxy usage headers. (M2)
      M2 done: `usage` KernelEvent per assistant message and `thread.usage` totals. R3: footer under the composer (model · in · out · cost, tooltip).

## P1 · Workbench (right pane)

- [~] **Multi-tab workbench** — Study (per study), any file, Program explorer; closeable, persisted.
      (R1)
- [~] **Study / Program naming**, VS Code-like file tree, text editor with Save, HTML
      preview/source. (R1)
- [~] **Edit the Study by hand** — double-click a field, writes program.json as researcher origin.
      (R1)
- [~] **Multi-select to ask** — click to toggle items, selection bar, titles in chips. (R1)
- [~] **At a glance + reproducibility line** derived from program.issues; "Ask ↗" per section;
      framework to be refined with Yuanjun. (R1)
- [ ] **Review proposals** — `program.proposed.json` and `*.proposed.*` shown as a diff with
      Accept / Reject. (R3)
- [ ] **Open the paper at the quote** from any citation; reverse highlight from a PDF selection
      (web version has this; port `supportedBy`). (R3)
- [x] **Multiple windows** — ⌘⇧N opens another window on the same or another project. (M1)

## P1 · Science

- [x] **Build skill = Bench contract** — eight-file package, programBindings, harness interface,
      offline `check_package.py`. (dba4f2a)
- [x] **Simulate skill** — agents as participants through the hosted proxy. (dba4f2a)
- [ ] **Simulation results view** — the agent's `report.md` + `results.png` opened automatically
      when a simulation finishes. (R3)
- [ ] **Import my project from the Hub** (web first build → app). (M3 + web)
- [ ] **Publish to the community** — one folder per contribution under `community/<paper-key>/`,
      same paper by several people is never a conflict, GitHub users author their own PR and
      everyone else publishes through the Hub bot with full attribution; see
      `docs/design/community-publishing.md`. (M3)

## P2

- [ ] Windows: test on a real machine, code signing.
- [ ] Per-user quota and key revocation on the hosted proxy (web).
- [ ] Chinese UI strings (i18n), Settings → Language.
- [ ] Conversation export (markdown) and search.
- [ ] Crash and error reporting opt-in (research data consent covers it).
- [ ] Remove the redundant web `/api/studio/views` route.

## Waves and ownership

| Wave | Scope (files) | Model |
|---|---|---|
| R1 | `app/src/renderer/**` tabs, editor, login, selection (running) | Fable |
| M1 | `app/src/main/{opencode-install,menu,notify,windows}.ts`, hooks in `index.ts` | Sonnet |
| M2 | `app/src/main/kernel/**`, `threads.ts`, permission + history IPC and types | Sonnet |
| R2 | agent pane: markdown, diffs, model picker, queue, attach, version, permission UI, threads UI | Sonnet (after R1) |
| R3 | proposals review, source tracing, simulation view | Sonnet (after R2) |
| M3 | Hub import, community publish | later |
| K3 | `app/src/main/{runtime-core,runtime-install,assistant-install}.ts`, `pack/runtime/**`, kernel PATH env | Opus |

## 2026-10-14 beta account implementation

- [~] Checklist 1–3: desktop forgot/change password and confirmation resend; web callbacks in PR #17. Code and tests complete (49 desktop / 192 web); PR #17 merged; public /auth/reset + production authOrigin verified 200; production recovery email Delivered. Owner password reset + re-login and full signup confirmation acceptance remain open. Included in the 0.5.3-beta.2 build, with production email callback; installed app unchanged.
- [~] Checklist 9: Settings / native Help menu, private owner-scoped support queue and UUID receipts implemented; 6 tests pass. App details opt-in only. Team notification email/contact address and live user submission acceptance pending; team can process support_requests in Supabase dashboard.
- [ ] Remaining agreed beta items: see docs/beta-execution-checklist-2026-10-14.md.
- Owner excludes original items 4, 6, 14, 15; later authorized Apple notarization (13), now completed for the beta installer. Profile/optional ORCID deferred until after beta.

## 2026-10-14 recovery and sample follow-up

- [x] Repair missed OpenCode events after connection loss from native saved state; no task/tool resubmission for transport recovery. Dedupe text/tool/usage; retain question/permission decisions and Stop.
- [x] Budget recovery progress gate uses visible text or a completed tool, not token counts alone.
- [x] Editable desktop sample includes the actual PDF, four exact material JSONs and a short README walkthrough; packaged resource paths tested; preserve existing researcher edits.
- [~] Checklist 18: connection and output-limit recovery verified with installed OpenCode + local model fixtures; live hosted-owner dogfood remains pending.
- [~] Checklist 17: offline sample assets and README guidance complete; full first-use UI walkthrough and real-paper end-to-end owner acceptance remain pending.
- Validation: 61 regression checks, native kernel fixture runs, TypeScript and build pass. See docs/recovery-sample-2026-10-14.md.

- Release acceptance: 0.5.3-beta.3 Mac arm64 app notarized, stapler validated, Gatekeeper accepted; DMG checksum verified. Local installer prepared under app/dist/beta-2026-10-14-3. No public release or automatic-update rollout, current installed app unchanged.


### 2026-10-15 source reading / first-use follow-up
- [~] PDF zoom and persisted passage highlights: implemented for paper and auxiliary PDF tabs;
  sidecar JSON preserves exact selected text and page-relative boxes, feeds existing left chat.
  Removed selection/quote/page-text/quote-box clipping. Three data regressions and renderer typecheck pass;
  native mouse interaction and next notarized installer still pending.
- [~] Editable sample first-use guide: implemented by GPT-6 Luna, short and skippable, remembers dismissal.
- [x] Release integration: desktop fixes merged and 0.6.1 automatic updates published;
  signed/notarized Mac assets verified, with real arm64 quit-to-install acceptance.
