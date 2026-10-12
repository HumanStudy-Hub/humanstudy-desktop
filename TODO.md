# HumanStudy Hub desktop · backlog

Feature parity target: the Codex / Claude Code desktop apps, for social scientists. Each item
names its owner wave so several agents can work without touching the same files.
Status: `[ ]` open · `[~]` in progress · `[x]` done. Keep this file current in every PR.

## P0 · must work before anyone outside the team uses it

- [~] **Login front and center** — Sign in / email in the Home title bar; sign-in card in the chat
      when there is no model access. (wave R1, renderer)
- [x] **Model error without a key** — never force `openrouter/...` on opencode when no key or
      account exists; fall back to the user's own opencode setup. (ca1438f)
- [x] **Bundled agent kernel** — main side done: pinned opencode 1.18.21 downloads into userData on
      first run (SHA-256, resume, `kernel.install` IPC). Progress UI still to do in the renderer. (M1)
- [ ] **Permission prompts** — opencode `permission.asked` → Allow once / Allow for this project /
      Deny in the chat; honour Settings → Default permission. (wave M2 main, R2 renderer)
- [ ] **Conversation history** — threads per project, restored when a project is reopened; new
      thread button; thread list in the agent pane. (wave M2 main, R2 renderer)
- [ ] **Version everywhere** — version in Home footer and title bar tooltip, Settings → About with
      "Check for updates" and the changelog link; `npm version` bump to 0.2.0 at release. (R2)
- [ ] **Real end-to-end run** — sign in → promo code → Sonnet 5.5 build of a real paper →
      package passes `check_package.py` → simulate. Fix whatever breaks. (lead)
- [ ] **Notarized Mac build** — Apple agreement accepted at developer.apple.com, then
      `npm run dist:mac` notarizes; publish a draft GitHub release and test auto-update. (lead)

## P1 · Codex-level agent pane

- [ ] **Markdown rendering** of agent replies (headings, lists, tables, code with copy button,
      links open externally). (R2)
- [ ] **Tool calls as diffs** — file edits by the agent shown as unified diffs; program.json
      changes summarised as changed item titles with a "show in Study" link. (R2)
- [ ] **Model picker in the composer** (hosted list + own key models) and per-turn model;
      recommended default Sonnet 5.5, Haiku 5.5 for quick questions. (R2)
- [ ] **Queue vs interrupt** while the agent runs (the setting exists; implement both). (R2)
- [ ] **Attach files** — drag a PDF/CSV/image into the chat or project; `@file` mentions from the
      Program tree. (R2)
- [x] **Finished notification** — macOS/Windows notification and dock badge when a turn ends
      while the window is in the background. (M1)
- [x] **Native menu + shortcuts** — File (New project ⌘N, Open ⌘O, Close), Edit, View (panes
      ⌘1/⌘2/⌘3, zoom), Help (docs, release notes, report a problem). (M1)
- [ ] **Token/cost footer** — per-turn tokens and cost from the hosted proxy usage headers. (M2)

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
