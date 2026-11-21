# CLAUDE.md

HumanStudy Desktop: an Electron app. It also runs as the **cloud app**: the same renderer, main process and agent kernel run inside a per-user Vercel Sandbox (`app/web`). Researchers use it to turn behavioural-science papers into runnable experiments with an AI agent, and to simulate participants. `SPEC.md`, `RELEASING.md` and `docs/` hold the details.

## Current priority: the pilot release (0.8.4, Nov–Dec 2026)

This is our first commercial case study. Judge changes and reviews against this goal, not only against the diff.

The goal has two parts. First, outside testers can do the following in the **cloud app** without help, and no flow stops silently:
1. Sign up once with an invitation code.
2. Open a prepared study, either by forking it from the Library or by uploading a `.humanstudy.zip`.
3. Explore the research document and the experiment preview.
4. Ask the assistant for changes.
5. Run a small participant simulation after an explicit confirmation.

Testers are 20–30 non-experts from Prolific and about 5 researchers.

Second, we collect **complete, trustworthy interaction data** through research data contract v1 (`app/src/shared/research-contract.ts`):
- every click, including inside study artifacts (`artifact.interact` / `artifact.dwell` through the bridge);
- every sent chat message and its dispatch outcome (`conversation.submission`);
- agent turns, tools, artifacts, errors, timeouts and the `simulation.*` lifecycle;
- cost: hosted model request IDs;
- `visit_id`, session end reasons, and time per view.

Every event must be attributable to its account and visit, ordered, and linked from cause to effect. No event may be lost on timeout, reconnect, reload or crash. The cloud path uses an IndexedDB outbox, acknowledges only after an atomic write, and runs a bounded flush at shutdown.

### What reviewers should look for

- **Lost or duplicated events.** Check every transport hop: browser → sandbox → Supabase. Look for wrong attribution: the wrong account, the wrong visit, or a broken `caused_by`.
- **Privacy.**
  - No draft text or keystrokes.
  - No free text inside artifact interactions; the host-side guard accepts only IDs declared in the file.
  - The consent gate is respected.
  - No account sees another account's data, including through project sync.
- **Dead ends for a non-expert.**
  - Hidden prompts (permission prompts must not appear in project mode).
  - Unexplained stops or timeouts.
  - Desktop-only wording in the cloud app.
  - A preview that never appears after a fork.
- **Cost.**
  - A loop or recovery that burns hosted allowance.
  - Any simulation that runs without explicit confirmation.
- **Cloud lifecycle.**
  - A deadline self-stop that comes early or late.
  - Stop and reconnect behaviour.
  - Workspace restarts that kill running work.
- **Regressions** in desktop use, project sync and the scientific contract: participant wording is verbatim, and gaps are labelled `missing` rather than invented.

### Known and accepted, so don't spend findings on these

- There is no OS-level sandbox against hostile papers. Auto-approval is a text heuristic, and commands such as `find -delete` inside the project are allowed. We choose the papers, and every cloud workspace is isolated.
- The agent process can read the sandbox server's environment, so it could forge the runtime's end-reason marker. The Hub keeps its own authoritative visit end reason.
- Cloud garbage collection for project sync is disabled on purpose, until coordinated server-side GC exists.
- `pack/skills/preview/*` is vendored from the private humanstudy-sandbox repo: never hand-edit it. App-owned changes go in `make_preview.py`.
- Known local test failures on Python 3.9: `runtime.test.mjs` (python unit tests), `src/shared/human-program.test.mjs`, and pack T11.

## Working rules

- Integrate on `dev`. `main` is the release branch and changes only through a reviewed `dev` → `main` pull request that the owner has approved.
- Run `npm run typecheck` and the relevant `node --test` files in `app/` before a PR.
