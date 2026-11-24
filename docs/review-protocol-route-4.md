not yet

Review 4 of `claude/protocol-route` at HEAD `7ad9163` (worktree hsd-protocol-route). I read review 3 and checked each of its items against HEAD. I read the diffs `7ad9163~1..HEAD` and `cdcfc9e..HEAD` (the same single commit) and the code they call: app_run.py, budget.py, protocol_report.py, render.py `make_chat_f`, humanstudy_llm `chat`, model-relay.ts, pack.ts, index.ts `kernel:send`, run-stop.ts, the kernel env, protocol-readiness.ts `confinedPython`, the vendored checks.py private-config loader and score.py, and sync_hsenv.sh. Everything I wrote or ran lives in my scratch folder, not the worktree. Probes I ran:
- I sent CJK, emoji, mixed-Unicode and ASCII pages through the real `humanstudy_llm.chat` with `urlopen` stubbed out, and compared the bytes it sends with `budget.call_charge`.
- I raced a stopped run against a resume: one process held `RunLock`, saw STOP and ended as `stopped`, the way `app_run.stopped` does, while a fresh approval waited on the lock.
- I took the sync guard's Python out of the script (the script has no dry mode), planted surnames in nine forms in a scratch copy of the vendored engine and its schemas, and ran the guard against the real upstream studies folder.
- I grepped every commit's added lines and message in `693f0fa~1..HEAD`, and every file changed since `0d9343f`, for upstream folder names, author surnames (3 letters or more), id shapes and home paths.

Test results (keys unset; Python at /usr/local/bin/python3):
- App suite, using CI's file list minus live, native-live and runtime: 272 tests, 270 pass, 0 fail, 2 skips.
- `npm run typecheck`: clean. `electron-vite build`: OK.
- `pack/runtime/tests`: 556 tests, with 2 errors. Both are `No module named 'jsonschema'`, an environment gap.
- `scripts/tests`: 15 tests, 1 failure (`test_prepare_conversion`, the malformed-program check). It fails the same way on `0d9343f` (main), so the branch did not cause it.

Review 3's two must-fixes are fixed, and so are most of its smaller items. One new must-fix remains: the resume-after-Stop path that round 3's S2 fix added refuses in exactly the case it was built for.

## Review 3 findings vs code

- **M1 (headline vs reward layer): fixed.**
  - `protocol_report.outcome` (`protocol_report.py:104`) works in three steps:
    - a partial run gives `not_ready`;
    - a run where `evaluation.plan.official` is not true gives `unknown` ("Finished");
    - an official run takes the `passed` verdict of the engine's `direction_match*` reward and maps it to `agree` or `disagree` (`passed` None gives `unknown`).
  - The sign table no longer sets the headline.
  - The new i18n keys (`i18n-dict.ts:159-160`) say "Directions agreed / did not agree with the paper (official n, engine check)". `parseSummary` passes `agree` and `disagree` through before its regexes run.
  - `paragraph()` adds "Offline report · non_official … no pass/fail" (`:141`) or the official direction sentence (`:136`). Nothing claims an effect was shown.
  - Residue: S2 below (an official verdict on an unverified human n) and a cosmetic gap (styles.css has no `o-agree` or `o-disagree` colours, so both render unstyled).
- **M2 (budget undercounts non-ASCII): fixed and exact.**
  - `budget.call_charge` (`budget.py:42`) serialises `{model, messages:[system,user], temperature, max_tokens}` with `json.dumps` defaults, which is what `humanstudy_llm.chat` sends (`humanstudy_llm.py:177`). render's `make_chat_f` sends exactly those two messages and app_run passes no seed.
  - Measured against the real `chat()` with a typical model id: ASCII, CJK, emoji (surrogate pairs at 12 bytes) and mixed escapes all come out at exactly +94 bytes per call, the slack of the 120-character model placeholder. The over-count is the same on every page because the escaping is counted exactly.
  - A model id over 120 characters would under-count by its excess length per call. The hosted model list has no such id, and the 1.5 margin absorbs it.
  - Covered by a CJK test.
- **S1 (study residue in checks.py): fixed in HEAD.** The comment is scrubbed (`checks.py:1056`) and VERSION is re-hashed. The new guard rule works for the case it targets. Its false negatives are listed in S3 below.
- **S2 (single runner): partly fixed. One half is fixed wrongly (new M1).**
  - `RunLock` (`app_run.py:157`) takes an `fcntl.flock` on `<run>/run.lock`, or `msvcrt.locking` on Windows, for the life of the process. The OS releases it on any exit or crash, so a stale lock, pid reuse or a start-time check cannot arise: the pid and time in the file are only for people.
  - Python fds are non-inheritable, so the lock does not leak into child processes.
  - Two starts without a Stop: the second refuses at once (`wait=0`). This is correct, and the test covers it.
  - A resume after Stop while the old process is still alive: broken, see M1.
- **S3 (editable `.opencode` copy): fixed as written, but the restore does not bind what runs (new S1).** `refreshAppOwned` (`pack.ts:143`) is called in `kernel:send` before the relay starts (`index.ts:708`). It writes only the files `refreshPack` already keeps at the shipped version: HELPERS, the engine and the artifact kit. It never touches SKILL.md, researcher files or anything else, so it clobbers nothing that opening the project does not already overwrite.
- **S4 (`HSENV_PRIVATE_CONFIG=''` everywhere): fixed.** It is set in:
  - the kernel env, inherited by everything the agent runs (`opencode.ts:615`);
  - the gate and budget spawn (`protocol-readiness.ts:153`);
  - run_confined, on both the relay path and `run_unconfined` (`:25`, `:75`);
  - simkit `_start` (`:266`);
  - app_run, budget and make_preview, before any hsenv import.

  checks.py treats `''` as "none" (`checks.py:888-891`). The test plants a path and sees it overridden.
- **S5 (Stop by realpath): fixed** (`run-stop.ts:17`), with a fallback to `resolve` when the path is missing. Covered by the run-stop test.
- **S6 (partial briefly "done"): fixed.**
  - `run_study.Progress.stage` is wrapped so that `done` becomes `writing` (`app_run.py:318`) and restored in `finally`.
  - `failed` is written before the page is built (`:345`).
  - A page error keeps `failed` and re-raises.
  - `done` is written only when the run is complete and its page exists.
- **S7 (partial shows verdicts): fixed.** Every reward reads "no verdict (partial run)" (`protocol_report.py:175`), and the text report, which prints `passed=`, is left out.
- **S8 (smaller items): all fixed.**
  - The token cap is matched by `\bHTTP 402\b|\btoken cap\b` (`app_run.py:214`), which fits humanstudy_llm's `"HTTP 402: …"`.
  - SPEC.md lists protocol.json, sourcetext/, runs/ and variants/.
  - The `effects_core.py` drift is documented and left to the owner, which is acceptable.

## Must-fix

**M1. A resume right after Stop waits for the old process and then refuses, because the old process's own `stopped` write looks like a later Stop.**
- `main_run` first checks `stopped_at` against the new approval using STOP's mtime (earlier than the approval, so it passes), then waits up to 120 s on the lock (`app_run.py:290`).
- When the old process exits, it has just run `app_run.stopped` → `write_progress(run_dir, "stopped", …)` with `updatedAt` = now (`:272`).
- Once the lock is taken, `check_not_stopped` (`:299` → `:145`) recomputes `stopped_at = max(STOP mtime, progress.updatedAt)`, which is now later than `approvedAt`, and raises "the researcher stopped this run: it starts again only after a new Run simulation approval".
- Reproduced. A holder that sees STOP and writes `stopped` 3 s later made a fresh approval refuse after 2.7 s.
- This is the normal case, not an edge case:
  - after Stop, the old process keeps retrying its dead relay through humanstudy_llm's backoff (six attempts, roughly 40–75 s);
  - a researcher who presses Run again in that window gets a refusal that blames them for not approving.
- The S2 test misses it for two reasons:
  - its lock holder never writes `stopped`;
  - it dates the approval 1 s in the future (`pack.test.mjs:611`, also `:403`).
- No spend or data risk: the run refuses and holds no relay. It is still a regression of the feature this round added, and the doc describes it as working (`v080-protocol-route.md` "A resume after Stop waits up to 120 s … then refuses" reads as "then runs").
- Fix:
  - date a Stop by when the researcher asked for it, not by when the process finished: in `stopped()`, write `stopRequestedAt` (STOP's mtime) into progress.json, and have `stopped_at` prefer it over `updatedAt`;
  - or compute `at` once before the wait and reuse it inside the lock;
  - change the test so the holder writes `stopped` after an approval dated now.

## Should-fix

- **S1. The restore before a run narrows the window but does not decide what runs. The doc overstates it.**
  - `refreshAppOwned` runs when the approval message is sent. The agent then starts the run itself, and in the default `project` permission mode, edits inside the project are approved automatically. Three bypasses remain:
    - after the restore, the agent can edit `.opencode/skills/run/app_run.py` again before `simkit start`;
    - the entry point is `artifacts/simulations/<run>/run.py` (`app_run.py:37-48`, written by the agent-run `new`), which is not app-owned, is never restored, and can skip `app_run` entirely;
    - extra modules dropped into `.opencode/skills/run/` (sys.path[0] for run.py, `app_run.py:44`) are not removed, so they can shadow the engine or stdlib modules.
  - The token cap still bounds spend. What is not bound is the integrity of the binding check and of the scores.
  - Reword `v080-protocol-route.md:112` to say the restore puts the shipped code back but cannot stop an agent changing what runs afterwards, and that the cap is the only hard bound.
  - A real fix needs the main process to launch the protocol run from its trusted copy, as `trustedBudgetFiles` already does for the budget, instead of the agent.
- **S2. An official run's headline does not say when the human n is unverified.**
  - `run_study` marks a plan official when every arm runs at the human n, including an `n_paper` with no structured `n_analysed` (`n_unverified_arms`).
  - hsenv.score labels that verdict "UNVERIFIED n".
  - The tab still says "official n, engine check", and the paragraph says "Official n (the paper's analysed n in every arm)" (`protocol_report.py:136`).
  - When `plan.n_unverified_arms` is non-empty, say "on an unverified human n" in both places, or show `unknown`.
- **S3. The sync guard's surname rule has wide false negatives.** I planted a 4+ letter study surname in a scratch engine copy and ran the guard against the real studies folder.
  - Refused: a `#` comment and a docstring.
  - Passed (false negatives):
    - a string literal (e.g. an error message "label (<surname> S2b)");
    - an identifier `<surname>_items`;
    - a comment `<surname>_s2b` (`_` is in the lookaround);
    - a 2–3 letter surname (5 of the 42 folders are not covered: three have short surnames, two have no year);
    - `<surname><year>` with no topic, and a CamelCase `<Surname><year><Topic>` (the id regex is lowercase and needs a topic);
    - "<Surname> (<year>)" in a string;
    - any text after a `'"""'` literal, because the comment regex then pairs the wrong triple quotes;
    - a description in a vendored `.json` schema (`comments()` yields nothing for JSON).
  - Fix:
    - check surnames in all text, not only comments, and review the hits by hand: the vendored set is about 10 files;
    - let `_` and digits end a surname;
    - make the id regex case-insensitive and allow no topic.
  - Keep the whole-folder-name rule as the hard gate.
- **S4. Windows refusal path.** `msvcrt.locking` locks byte 0, and Windows enforces the lock against reads. So the waiting process's `self.fh.read()` (`app_run.py:188`) should raise `PermissionError` instead of the clean `Refused` message. It still refuses, but with a traceback. The S2 test is skipped on win32. Wrap the read in try/except.
- **S5. A provider outage burns the cap.** The relay charges before calling upstream, never refunds, and returns 502 on any upstream failure (`model-relay.ts`). humanstudy_llm retries 502 up to six times (`RETRY_STATUS`). Each failed call therefore reserves up to 6× its charge against a budget with a 1.5 margin. No money is lost (the provider rejected the calls), and the run ends partial. But one flaky provider minute can end a long run early. Return a non-retried status for an upstream rejection, or refund on upstream failure.

## Checked and correct

- **Headline and wording.** No path in protocol_report sets `replicated`, `partly` or `not_replicated` any more. The package route's outcomes are unchanged. `summary.official` is written. A partial run always gives `not_ready`.
- **Budget byte count.** Exact against `humanstudy_llm.chat` for ASCII, CJK, emoji and escaped control characters. The relay charges `bytes + 256 × messages + max_tokens` on the raw body, and the measurement counts the same.
- **Run lock races.**
  - The lock is the OS lock, so two simultaneous starts cannot both win.
  - The trial path takes the same lock.
  - The lock file holds no secret.
  - Crash safety needs no pid or start-time check, because the kernel drops the lock on any exit.
- **Restore safety.** `refreshAppOwned` writes only app-owned files that already exist in the bundle, skips identical files, and never deletes. It runs before the relay check, so a refused second approval also rewrites them. That is harmless, since the files are identical to what is shipped.
- **Private config.** `''` reaches every engine entry the app or the agent starts. The fallback sidecar path (`.opencode/coordinator/engine-private.json`) is never read in the desktop app.
- **Hygiene of HEAD.**
  - No upstream folder name, study id shape or home path in any file changed since `0d9343f`, and no study surname of 3 letters or more in added code.
  - The only surname hits are the public sample that is already on main (no added lines in the range) and test fixtures with made-up names. Hits on "li" are HTML.
  - The `/Users/` and `/home/` hits are the guard's regex and a code comment.
- **Commit messages** in `693f0fa~1..HEAD` name no study and no home path.
- **No remote branch contains `693f0fa`** (`git branch -r --contains` is empty).
- **Tests, typecheck and build** as listed above. Stop by realpath, partial-never-done, the verdicts hidden on a partial run and the HTTP 402 matching each have their own test, and all pass.

## Before push

1. **Squash the branch into one commit.** What the squash must remove:
   - `693f0fa` adds the vendored engine with 11 upstream folder names, 10 study ids and study surnames in `checks.py` and `engine.py`, and a home path in `pack/runtime/hsenv/VERSION`.
   - `41a8f95`, `a16f784`, `6b44416`, `ae13233`, `da8d6dd`, `beb24ff` and `cdcfc9e` still carry that engine or the surname comment in their trees.
   - `beb24ff` adds the surname comment that HEAD scrubs.
   - Only HEAD's tree is clean.

   After squashing, run `git log -p origin/main..HEAD` through a grep for the upstream folder names, their surnames, `[a-z]+(19|20)\d\d[a-z]+` and `/Users/`: there should be no hits other than the made-up fixtures (`author2024topic` and the two made-up names in pack.test.mjs).
2. **Do not commit `docs/review-protocol-route-1.md` or `-2.md`.** They name studies (4 and 6 lines of folder names, 5 and 7 lines of surnames). `-3.md` and this file name none. Keep both out anyway unless the owner wants review notes public.
3. Fix M1. S1's doc rewording is a one-line change and should go in with it.
4. Check again that `git branch -r --contains 693f0fa` is empty just before pushing.
