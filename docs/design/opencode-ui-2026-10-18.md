# OpenCode UI integration · 0.6.5 acceptance

User scope: expose the actual installed OpenCode capabilities, rather than a small hand-picked
chatbot API. Keep the HumanStudy appearance and source/program workbench. All features live
behind slash commands/command palette rather than permanent starter suggestions. Also investigate
UI lag during typing, scrolling and pane dragging. The previous automatic-paper-build workflow
was paused for discussion; its uncommitted code stays in hsd-verify and is NOT in this branch.

Working branch/worktree: codex/opencode-ui, ~/humanstudy/hsd-opencode-ui. Main baseline 077fee6,
release baseline 0.6.4; 0.6.5 is now published. Do not overwrite the running owner application during tests.

## Released implementation

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
- Node/web TypeScript checks and production renderer/main build passed for the release source.
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
- Packaged file-origin PTY handshake initially failed with 403; added explicit file:// origin
  permission while retaining authenticated single-use tickets. Actual Electron file-page PTY
  read/write then passed; unrelated origins and ticket reuse are regression checked.
- Modal focus stays within the dialog; terminal keyboard input is excluded from app shortcuts.
- Fixed terminal resize/reconnect timer interference, bounded reconnect attempts, stale catalog and
  panel response guards, share preview loading guard, and required VCS diff query parameters.

## Boundaries / outstanding acceptance

- 0.6.5 is published; release and public updater acceptance are recorded below.
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

## Published release acceptance

- PR #7 merged at aa73d603a44cf06ceffb9b7884269f727f50b060; tag v0.6.5 uses that source.
- Release https://github.com/HumanStudy-Hub/humanstudy-desktop/releases/tag/v0.6.5 is public/latest
  (release ID 416588179). Windows release CI 39148619091 completed successfully.
- Both Mac bundles pass codesign --verify --deep --strict, Gatekeeper reports Notarized Developer ID,
  and stapler validates both tickets. Nine remote Mac asset SHA256 digests/sizes match local files;
  all four Mac installer SHA512 digests/sizes match latest-mac.yml. Five Windows assets are present.
- Public latest-mac.yml is byte-identical to local metadata. Production /download now references 0.6.5.
- Isolated packaged 0.6.4 downloaded 0.6.5 through the ordinary public updater and the test bundle
  installed as 0.6.5. Reopened with explicit fixture arguments; real app reports 0.6.5, renderer
  mounts, native and export preload methods are present. All 35 fixture project/chat/settings
  files remain byte-identical. The owner's /Applications bundle remains 0.6.4, not replaced.
- Installer relaunch did not retain the custom test profile/debug arguments (known native updater
  behavior). The relaunched test copy was gracefully closed, then manually opened with fixture
  arguments for preservation checks. This is not a claim of custom-profile automatic relaunch
  preservation; ordinary default-profile use is distinct.
- Evidence: /private/tmp/humanstudy-0.6.5-final/{SHA256SUMS,release-verification.json},
  /private/tmp/hs-update-e2e-061/{upgrade-065.log,after-065.log,preservation-before-065.json,
  preservation-after-065.json}. Local evidence may be cleared by macOS temporary-file cleanup.
