# Installed Mac walkthrough: 0.6.7-rc.1 (2026-10-23)

Machine-readable evidence: [installed-mac.json](installed-mac.json). Screenshots and harness: [installed-mac/](installed-mac/). Tracker: issue #30 (T14).

## Build

- **Version and command.** `0.6.7-rc.1`, built from commit `bc48150` on this branch with `electron-vite build && node scripts/dist.mjs --mac dmg --arm64 --publish never`.
- **Notarization.** Done with the keychain profile `humanstudy-notary`.
- **dmg.** `HumanStudy-Hub-0.6.7-rc.1-mac-arm64.dmg`, 128,421,232 bytes, sha256 `069cb400…15ab`. It is local only, not uploaded.
- **The app inside.** `codesign --verify --deep --strict` passes. `spctl` reports *accepted, Notarized Developer ID*, and the stapler check passes.
- **The dmg container itself is unsigned.** That is electron-builder's default.
- **Nothing published.** No tag, no GitHub release, and no change to the update channel.
- **Existing users cannot receive this build.**
  - `updates.ts` never sets `allowPrerelease`, so installed 0.6.6 copies keep electron-updater 6.8.9's default of `false`.
  - With that default, the GitHub provider only asks for `/releases/latest`, and GitHub never returns a draft or prerelease there. The latest release is still v0.6.6.
  - The rc build itself would accept later prereleases, but it never downgrades.

## How it was run

- **Install.** The app was copied from the mounted dmg into a private temporary folder, not `/Applications`.
- **Launch.** Playwright `_electron.launch` started the **installed** executable with `--user-data-dir=<isolated>`, with the projects folder inside that directory. The test confirmed `isPackaged=true` and the isolated `userData` path.
- **UI-only setup.** The kernel was set to `HUMANSTUDY_KERNEL=mock`, and `HUMANSTUDY_SERVER` pointed at a local mock account and research server.
  - The installed app's own `safeStorage` encrypted a synthetic signed-in session (placeholder JWT, no refresh).
  - No real account, model or research delivery was involved.
  - The owner's app data and projects were not touched.
- **Real-model evidence** is in [real-model.md](real-model.md).
- **Fixture.** A synthetic project with two generated one-page PDFs that share a sentence, a CRLF and 4-space-indented `program.json`, and package fixtures.

## Results: 10/10 checks passed

| # | Tester repro | Result |
| --- | --- | --- |
| W0 | Installed app, isolated profile | packaged 0.6.7-rc.1, isolated `userData` |
| W1 (#15) | Home → From a paper | The build request (`build.prompt`) was sent automatically, with no question. The Study tab showed "Building the study from the paper · Reading the paper…" |
| W1b (#15, T03) | Build ends without a certified program | "The agent stopped before the study was complete … Try again"; not reported complete |
| W2 (#19) | `package/x/task/adapter.py` contains only a comment | No **Run** button. The notice lists what is missing, including `run_sessions`, and offers "Ask the agent to complete it" |
| W3 (#16/#19) | Complete package, then Run, then Stop while "Getting ready" | **Run** appeared. "Getting ready" was shown. **Stop** returned the tab to idle with Run available again |
| W4 (#17) | Type in `review_notes.txt`, switch to Study and back | The draft was kept and the label still said **Save**. Nothing was written until Save was clicked |
| W5 (#17) | Fill *Background and gap* in the Study view | Only the 3 lines of that field changed (value, `origin: researcher`, `state: confirmed`). All other JSON was identical, and CRLF and 4-space indentation were kept |
| W6 (#18) | Citation "p>.001" against a source that says "p<.001" | Located but flagged, with `>` and `<` marked. The clean quote shows "Text located on this page by automatic matching — not a confirmation". The word "verified" appears nowhere |
| W7 (#18) | Drag-select a sentence in paper A in compare view | "Selected passage · paper.pdf, p. 1 is cited by …" first, then "Same words, cited from another source: … sources/doc-b.pdf" |
| W8 (#18) | Replace `paper.pdf` at the same path | The viewer reloaded to the new document with "paper.pdf changed on disk and was reloaded. Showing the version saved …" |

Two earlier rc.1 builds of this branch, made before fixes `42e5944` and `4200039`, also passed 10/10. Only the final build is reported here.

## Observations

- **Mock-mode error banner.** In mock mode, every conversation shows "Agent unavailable: … `kernel:native` … unavailable in mock mode". This only happens with the mock kernel.
- **Mock agent and the word "run".** The mock agent treats "run" in the build prompt ("Do not run a simulation") as a command that needs approval. W1b declines it. This also only happens with the mock kernel.

## Not covered

- A real model inside the installed UI.
- Quitting during a real build and reopening.
- Offline delivery or restart, and account export, on the installed app.
- Downloading and installing an update.
- Draft-on-quit and multi-window dialogs.
- Windows (T15).
