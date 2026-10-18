# OpenCode UI integration · work in progress

User scope: expose the actual installed OpenCode capabilities, rather than a small hand-picked
chatbot API. Keep the HumanStudy appearance and source/program workbench. All features live
behind slash commands/command palette rather than permanent starter suggestions. Also investigate
UI lag during typing, scrolling and pane dragging. The previous automatic-paper-build workflow
was paused for discussion; its uncommitted code stays in hsd-verify and is NOT in this branch.

Working branch/worktree: codex/opencode-ui, ~/humanstudy/hsd-opencode-ui. Main baseline 077fee6,
public release still 0.6.4. Do not overwrite the running owner application during tests.

## Implementation so far (not released)

- Verified installed v1.19.0 via isolated /doc; API snapshot /private/tmp/hs-opencode-119-openapi.json.
- Typed native requests in shared/native.ts; named routing in kernel/native-api.ts; scoped native()
  bridge in OpencodeKernel. No raw URL/Basic password enters the renderer. Secrets in config and
  provider responses are hidden; complete scientific/history payloads are not clipped.
- IPC/preload → useSession.native() → / command registry, dynamic native commands/skills catalog.
- NativePanel provides agents/models/variants, commands/skills/tools/resources, MCP/provider auth,
  sessions/timeline/fork/undo/redo, shell, context/status/tasks/diff, file/search, native settings,
  saved permissions, worktrees/workspaces/adapters and native connected-service organization reads.
- Native interactive PTY uses official pinned xterm 6.0.0 + fit 0.11.0, ticketed WebSocket,
  resize and bounded reconnect. xterm is lazy-loaded. ws is a pinned dev-only test dependency.
- Native history import/fork/undo/redo updates local threads and archives the prior full JSON under
  .humanstudy/thread-history. Archive hides local thread; native sessions remain reopenable.
- Sharing is explicitly previewed and backend checks the preview hash before publishing.
- Command palette: /, Cmd/Ctrl+Shift+P. ! prefix calls real shell endpoint. No starter suggestion chips.
- Message rows memoized; scroll follows only when near bottom; off-screen content uses browser
  content-visibility rather than deleting history. No claims of measured lag resolution yet.

## Verified on 2026-10-18

- Full desktop regression suite: 65 passed. Additional kernel suite: 13 passed.
- Node/web TypeScript checks and production renderer/main build passed; rerun after final edits.
- Native routing/redaction/history tests: complete Unicode content, scoped IDs, unknown parts,
  revert visibility, and credential response hiding; no scientific content clipping.
- ThreadManager tests: native user IDs, full original undo snapshots, archived session reopening
  after restart without duplicating local threads, and per-thread agent/model/variant restoration.
- Actual installed hs-v1.19.0 plus isolated Git project, fake local model and local MCP server:
  native reads/context/commands, selected agent/variant, compaction retaining original records,
  real tracked-file undo/redo, fork, rename/archive/open, shell, ticketed PTY read/write/resize/close,
  MCP add/connect/disconnect/reconnect, provider key add/remove. No owner credentials or model quota.
- Actual native output-limit and malformed-tool automatic recovery tests passed after integration.
- Real Electron/Chromium UI with 800 full messages (about 1.1 MB of fixture text): input retained
  every character, reading history did not jump to bottom, palette dispatched compact, model variant
  selected, conditional provider prompts reached authorization, MCP callback used its own route.
  Measured typing and chat-pane resizing p95 about 17–18 ms, including two animation frames.
  Timings are reported, not hard CI thresholds that fail when the machine is busy.
- Modal focus stays within the dialog; terminal keyboard input is excluded from app shortcuts.
- Fixed terminal resize/reconnect timer interference, bounded reconnect attempts, stale catalog and
  panel response guards, share preview loading guard, and required VCS diff query parameters.

## Boundaries / outstanding acceptance

- Release target 0.6.5; signing, notarization and public updater acceptance recorded below when done.
- Real external OAuth sign-in, public conversation sharing, service organizations and optional
  workspace adapters still need their respective live accounts/services. The UI uses native routes
  and surfaces their actual errors; local fixtures are not a claim those services authenticated.
- No Windows hardware or Intel hardware UI test. Windows remains preview.
- This benchmark did not reproduce the owner's original transient lag, or the older CPU runaway.
  It covers the chat path and chat pane resizing, not a long live PDF/simulation workload.
- Automatic first-paper build remains paused in hsd-verify, including its independent draft PDF
  transport guard. This branch does not activate that workflow or promise program generation.
- App-managed authentication, updater and safe shutdown remain authoritative. Native global
  upgrade/dispose/TUI lifecycle routes are not exposed as researcher commands.

Implementation notes: native fixtures use a nested isolated Git repo to avoid snapshots of the
actual development checkout. macOS /var vs /private/var aliases need realpath comparisons. PTY
connect-token returns {ticket,expires_in} and requires x-opencode-ticket:1. Basic auth never enters
renderer code. Compaction preserves the saved conversation; undo archives complete local history.
