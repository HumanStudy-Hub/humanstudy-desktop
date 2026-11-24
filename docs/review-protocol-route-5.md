not yet

Review 5 of `claude/protocol-route` at HEAD `c00433e` (worktree hsd-protocol-route). I checked every item of review 4 against HEAD and read the whole of `c00433e`: protocol-run.ts, launch.py, the `kernel:send` changes in index.ts, `trustedRunFiles` in pack.ts, app_run.py, protocol_report.py, model-relay.ts, sync_hsenv.sh, the renderer and shared changes, SKILL.md and the doc. I also read the code these call: sandbox_run.py (profile, env, boot), run_confined.py, run_study.py (`resolve_study`, `load_protocol`, `run`, salt), the engine's asset loader, the opencode kernel env, run-stop.ts and run-approval.ts. Everything I wrote or ran is in my scratch folder; the only file I wrote in the worktree is this one. Probes:
- **plan.json tampering.** I set up a scratch trusted-copy layout (skills/run, hsenv, artifact-kit) and a project from the protocol-mini fixture. I wrote a plan.json with the right protocol hash but perArm 7, seeds [1,2,3] and temperature 0, set the `HUMANSTUDY_RUN_*` binding env the app would set, and ran `app_run.main_run` with a stub model. It ran `n_per_arm` 7 × 3 seeds = 42 participants and ended `done`. Nothing compares plan.json with the approval.
- **Sync guard, `--check` mode.** I copied the vendored engine and schemas to scratch and planted surnames from the real upstream studies folder in 17 forms, one per run, with STUDIES_DIR pointing at that folder. Results are under S3. `--check` passes on the real upstream engine and skills, and on HEAD's vendored copy. It wrote nothing in the worktree (git status unchanged).
- **Environment of a same-user process.** On this Mac, `ps eww` does not show another process's environment, but `sysctl KERN_PROCARGS2` from an ordinary same-user Python does. I read a test token from the environment of a running Python process.
- **Hygiene.** I scanned every file changed since `0d9343f` (main) at HEAD, the added lines and message of every commit in `0d9343f..HEAD`, and the untracked review docs. The scan looked for upstream study folder names, their surnames (3 letters or more), id shapes and home paths. I counted hits and recorded file:line only; no term is printed here.

Test results (keys unset; Python /usr/local/bin/python3 3.13 first on PATH; node 22 x64, the arch the installed esbuild matches; arm64 node 20 fails every esbuild-based test):
- App suite, CI's file list minus live, native-live and runtime: 279 tests, 277 pass, 0 fail, 2 skipped. Both new protocol-run tests ran, the pre-relay one and the macOS sandbox-plus-relay one, and pass.
- `npm run typecheck`: clean. `electron-vite build` (output to scratch): OK.
- `pack/runtime/tests`: 556 tests, 2 errors, both `No module named 'jsonschema'` (environment), 31 skipped.
- `scripts/tests`: 15 tests, 1 failure (`test_prepare_conversion`, malformed-program check). It also fails on main, as review 4 found.

S1 is a real improvement. The engine, run skill and kit that run are the app's copy, and agent files in `.opencode/` or `artifacts/simulations/` are not imported; the test proves it. But three things still let the agent decide what runs, or break it:
- the approved plan sits in an agent-writable file that nothing checks;
- the old run's exit closes the new run's relay;
- the protocol run's relay capability is still handed to the agent.

## Review 4 findings vs code

- **M1 (resume after Stop refused): fixed in code, but now unreachable from the app.**
  - `stopped()` writes `stopRequestedAt` = STOP's mtime (`app_run.py:288`). `stopped_at` prefers it over `updatedAt` and takes the latest request (`:126-139`). `write_progress` drops it on any later stage.
  - The test (`pack.test.mjs`, "review 3 S2 / review 4 M1") has a holder write `stopped` and passes.
  - However, every approval now gets a new folder (`newRunFolder`, `protocol-run.ts:17`; `index.ts:706`). The app never resumes a stopped folder, so the 120 s wait and the `fresh_after_stop` path only run when someone starts a run by hand.
  - The doc still says "A resume after Stop waits up to 120 s … then runs" (`v080-protocol-route.md:144`). Say instead that Run after Stop starts a fresh run in a new folder. Also see the new M2, which this change causes.
- **S1 (restore does not bind what runs): mostly fixed. Inputs are not bound (M1) and neither is the capability (M3).**
  - The main process copies `trustedRunFiles()` into `userData/protocol-runs/<uuid>/` and starts `launch.py` with `-I -B`, with PYTHONPATH, PYTHONHOME and PYTHONSTARTUP deleted (`protocol-run.ts:60-61`).
  - `launch.py` runs `app_run.py run` through `sandbox_run.run_python`, whose boot is `-I -B`, whose env is minimal and whose sys.path[0] is the trusted `skills/run`.
  - The kit is taken from `<code>/artifact-kit` first (`protocol_report.py:286`). The engine path in run.json is the copy's (asserted in the test).
  - The doc rewording review 4 asked for is in (`v080-protocol-route.md:135-139`).
- **S2 (unverified human n): fixed.**
  - `outcome` returns `agree_unverified` / `disagree_unverified` when `plan.n_unverified_arms` is non-empty.
  - The paragraph says "Official n, but on an unverified human n (… in <arms>)".
  - The i18n keys exist in en and zh, `parseSummary` passes the new values through, and both `.sim-outcome` and `.sim-summary` render them amber.
  - Wording nit: "(official n, engine check), on an unverified human n" contradicts itself. "(paper's printed n, not verified; engine check)" reads better.
- **S3 (guard false negatives): largely fixed.** The planted forms now refused:
  - a comment;
  - a string literal;
  - `<surname>_x`;
  - `<surname>2`;
  - `<surname><year>` with no topic;
  - `<Surname><year><Topic>`;
  - "<Surname> (<year>)";
  - text after a `'"""'` literal;
  - a description in a JSON schema;
  - a short surname next to a year or "et al".

  Still passing:
  - **CamelCase compounds:** `get<Surname>` and `<Surname>Items`. The lookarounds are `[A-Za-z]`, so a letter on either side hides the surname. This is the likeliest real-world miss.
  - **A short surname without a year** (`<short>_s2`). This is deliberate.
  - **Obfuscated forms:** `\u` escapes, split string concatenation and hex. These are adversarial and acceptable.
  - **No-year folders:** 3 of the 42 folders have no year, so their surnames are covered only by the folder-name rule.

  Suggestion: for 4+ letter surnames, also match on a case boundary, e.g. `(?<![a-z])Surname(?![a-z])` on the original case. `--check` is a gate in engine mode only, not a LICENSE check (the copy path checks LICENSE; `--check` does not).
- **S4 (Windows lock read): fixed.** The read is in try/except (`app_run.py:192-197`), with a plain message. It is still untested on win32 (the test skips there).
- **S5 (outage burns the cap): partly fixed.** A non-2xx answer is refunded (`model-relay.ts:103-109`), and the test covers 503 ×10 then cap intact.
  - A thrown fetch is not refunded: connection refused/reset, DNS failure, the 120 s timeout (`:117`). Those are the commonest outage shapes, so an outage can still burn the cap. That is the safe direction.
  - The refund itself can be abused; see S1 below.

## Must-fix

**M1. The approved plan is not bound: app_run plays whatever plan.json says.**
- The app writes `plan.json` into the run folder inside the project (`protocol-run.ts:47-48`). `main_run` reads perArm, arms, seeds and temperature from that file (`app_run.py:297`, `:334`). Only `protocolSha256` is checked against the binding env (`check_approval`, `:105`).
- An agent process that rewrites the file between the app's write and the run's read can change n, arms and seeds, with no bound on perArm in `main_run`. For example, a watcher left running in the background from an earlier turn could do this.
- The engine computes `official` from n per arm, so this also lets the agent turn a non_official run into an "official" verdict, or the reverse.
- Reproduced: approved 2 per arm, plan.json said 7 × 3 seeds, and the run played 42 participants and ended `done`. The relay cap still bounds spend (the run ends partial on 402), so this is integrity, not money. But "plan.json comes from the checked approval" is exactly what the commit and the doc claim.
- Fix: pass the plan in the launch env, e.g. `HUMANSTUDY_RUN_PLAN` (JSON) or its SHA-256, next to `HUMANSTUDY_RUN_PROTOCOL_SHA256` (`protocol-run.ts:54-59`, and forward it in `launch.py:35`). `main_run` should refuse unless plan.json's route, hash, perArm, arms, seeds and temperature equal it, or should take them from the env and treat the file as a record only.
- Add a test that edits plan.json after launch.

**M2. When a stopped run's process exits, it closes the next run's relay.**
- `onExit: () => { if (relay) void closeRunRelay(id) }` (`index.ts:713`) closes whatever relay is registered under the session id when the child exits, not the relay this run was given.
- After Stop, the old process lives on while humanstudy_llm backs off against the dead relay; review 4 measured roughly 40–75 s. Meanwhile `closeRunRelay` has already cleared `relayProjects`, so the researcher can press Run again, which registers relay B under the same `id` (`:751`).
- When the old process exits, `onExit` closes B, and the new run fails partial for no visible reason.
- Fix: close the specific relay, e.g. `onExit: () => void relay.close()` (`finish` is idempotent) plus `if (runRelays.get(id)?.close === relay.close) runRelays.delete(id)`. `onClose` (`:748`) should likewise delete only its own entry.
- Add a test that starts two relays on one session id.

**M3. The protocol run's relay capability is still handed to the agent.**
- `startModelRelay` writes the descriptor, token included, for the protocol route too (`model-relay.ts:129`). The agent's kernel gets `HUMANSTUDY_RELAY_DESCRIPTOR` on macOS (`opencode.ts:656`). `cat` of that path is a read-only bash command.
- The agent can therefore do three things:
  - run `run_confined.py` on its own script placed inside the app's run folder (`run_confined.py:59`, `work=script.parent`). That script runs with the protocol capability, writes the app's progress.json, run.json, results.html and summary.json, spends the shared cap, and can POST `/run/complete`, which ends the app's run;
  - curl the relay directly from its unconfined shell;
  - skip the capability's binding checks altogether, since run_confined does not check the route.
- S1's point was that, on the protocol route, only the app's run holds model access.
- Fix: the app already passes the relay to `launch.py` directly, so do not write the descriptor (or write it without `token`) when `binding.route === 'protocol'`, and make run_confined refuse a protocol descriptor.
- Residual, to document: `launch.py` and the confined child hold the token in their initial environment, which a same-user process can read through `KERN_PROCARGS2`. I reproduced this on this Mac. `sandbox_run.py`'s docstring already admits it for keys. Passing the token on stdin or a pipe fd, and setting it into `os.environ` before importing humanstudy_llm, would close it.

## Should-fix

- **S1. Refunds trust any non-2xx answer, so the cap can be exceeded by calls that were billed.**
  - The relay refunds whenever `!upstream.ok`.
  - With the hosted upstream, a 5xx/504 can come after the upstream provider has already generated and billed the call. A gateway or function timeout on a long prompt with `max_tokens` 4096 on a slow model is one way.
  - The client chooses the prompt and the output limit, so a run can repeat such calls and each one comes back refunded.
  - Fix: refund only statuses that mean the call was not processed (400, 401, 403, 404, 413, 422, 429, and 503 if the hosted server guarantees it), not 500, 502, 504 or 524. Also cap total refunds, e.g. at the cap itself, and log the status (already done).
- **S2. A run that dies before app_run writes progress.json is never reported.**
  - Several ways the run can exit with no progress.json, so the folder shows "running" and then "stopped" by staleness (`simulation-run.ts:174`):
    - `Refused` from `check_approval` (protocol changed between the app's check and the run's);
    - the run lock;
    - "invalid model relay";
    - sandbox code 126 ("foreign sandbox");
    - an ImportError (e.g. humanstudy_llm missing from a broken runtime);
    - a spawn error.
  - The agent's skill polls until `done`, `failed` or `stopped` (`SKILL.md` step 1), so it loops on a folder that will never get there.
  - Fix: in `onExit`, when the code is non-zero and progress.json is missing or not terminal, have the main process write `failed` with the tail of run.log.
- **S3. TOCTOU on protocol.json and an unhashed `variant.json`.**
  - `check_approval` hashes protocol.json, then `run_study.load_protocol` reads it again (`run_study.py:171`). Fix: compare `meta["protocol_sha256"]` with the binding after `run_study.run`, or pass the bytes.
  - `resolve_study` honours a `variant.json` in the project (`run_study.py:161`), which nothing hashes or checks. It flips the run to "not the original experiment" or non_official, and moves the asset root to an agent-chosen path (readable only inside the sandbox's read set). Fix: refuse when `variant.json` exists on the app route, or include it in the binding.
- **S4. The run folder may sit outside the project.**
  - `newRunFolder` uses `join(project, 'artifacts', 'simulations', …)` and `existsSync`. If `artifacts/simulations` is a symlink, the app (unconfined) writes plan.json and `.operator/*.salt` at its target, and `launch.py` gives the sandbox write access there (`work=run_dir`, resolved).
  - The written names are fixed and the agent can already write as the user, so the impact is small. But the confined run's write root should be checked: realpath the folder and require it to be inside the project's realpath, as `run_stop` already does.
  - A pre-created `.operator/<stamp>.salt` (the stamp is predictable to the minute) makes the `wx` write fail, which refuses the run (DoS only).
- **S5. The pre-relay path (Linux, Windows) has no main-process guard.**
  - The `else if` branch (`index.ts:755`) does not use `relayProjects` or any other one-run-per-project check, so two approvals start two unconfined, detached runs that each spend the key with no cap.
  - The child is spawned `detached` with `stdio: 'ignore'`, so it outlives the app on Linux.
  - Fix: keep a per-project set for the pre-relay path too, released on exit.
  - The doc says "The relay's token cap remains the hard bound on spend in every case" (`v080-protocol-route.md:138`). It is not on Linux and Windows. Say so.
- **S6. Trust boundary wording.**
  - "Nothing the agent can edit is ever on the run's sys.path" holds for the project. The code copy (`userData/protocol-runs/<uuid>/`) and the runtime's site-packages are still the same user's files. An approved bash command can rewrite them while a run is going, and `protocol_report` and `inline` are imported only at the end of the run.
  - The doc should name the boundary as "files the agent edits without asking": the project. The copies are also never removed, so they accumulate; delete the folder on exit.
- **S7. Doc: resume and outcome.** Fix `v080-protocol-route.md:144` (see M1 above), and say in the doc that Stop followed by Run starts a fresh run, whose partial data the old folder keeps.

## Checked and correct

- **Code provenance.**
  - `trustedRunFiles()` matches launch.py's layout (`hsenv/`, `skills/run/`, `skills/build/sandbox_run.py`, `artifact-kit/`).
  - `run_study.HSENV` resolves to the copy.
  - humanstudy_llm comes from the managed runtime's site-packages, which `-I` keeps.
  - `-I` in both launch and boot drops cwd, PYTHON* and the user site.
  - The launch env on the relay path is PATH only.
  - The test plants code in `.opencode/skills/run`, `.opencode/hsenv` and `artifacts/simulations/json.py`; none of it runs.
- **runId.** `randomUUID()`, so there is no traversal. `codeDir` sits under userData and is `rm`'d before it is written.
- **Hash binding.** All four hashes must equal `approved.protocolHash`: `approvedRunLimits` (budget from the same bytes), the binding in `kernel:send`, `launchProtocolRun`, and app_run against the env. The pre-relay branch checks the hash too.
- **Sandbox profile (relay path).**
  - Reads of home, /Users, /Volumes and the temp roots are denied except the run folder, the project, the code copy, the skills folder and the Python dirs.
  - So userData (known-projects list, settings, relay descriptors) and `~/.ssh` stay unreadable.
  - Writes go only to the run folder. Network goes only to the relay port.
  - The profile is inline.
  - A symlinked protocol.json pointing outside resolves to a denied path.
- **Salt.** `.operator/<run>.salt` is written `wx`, mode 0600, outside the run folder. run_study reads it. The Simulation tab now skips dot folders, and `copy_tree` excludes dotfiles from exports.
- **Stop, lock, partial and budget on the new path.**
  - Stop's STOP write closes the project's relays (`index.ts:502`), and the run records partial.jsonl and ends `stopped`.
  - `RunLock` is taken (wait 0 in a fresh folder).
  - `top_up=False`, and the cap comes from `approvedRunLimits`.
  - Partial runs never show `done`.
  - A failure inside `kernel:send` after the relay started closes it.
- **Hygiene of HEAD.**
  - No upstream folder name in any file changed since main.
  - Surname hits exist only on lines unchanged from main (the public sample and its test).
  - The id-shape hits are made-up fixtures and the guard's own comment.
  - The `/Users/`/`/home/` hits are the guard regex and a code comment.
  - No commit message in the range matches anything.
  - `git branch -r --contains 693f0fa` and `… c00433e` are both empty.

## Before push

1. **Squash `0d9343f..HEAD` (10 commits) into one.** What the squash must remove:
   - `693f0fa` adds the vendored engine with 11 folder-name hits, 11 surname hits, 10 id shapes and 1 home path;
   - `beb24ff` adds a surname comment that HEAD scrubs;
   - `41a8f95` through `cdcfc9e` carry that engine in their trees.

   After squashing, grep `git log -p origin/main..HEAD` for the folder names, the surnames, `[A-Za-z]{2,}(19|20)\d\d[A-Za-z]*` and `/Users/`. The only hits should be the made-up fixtures in pack.test.mjs and the guard's own text.
2. **Keep `docs/review-protocol-route-1.md` and `-2.md` out of the commit.** -1 has 9 folder names, 9 surnames, 8 id shapes and a home path; -2 has 10, 10 and 8. -3, -4 and this file name no study (-4 contains only the regex and generic paths). Keep all review notes out unless the owner wants them public.
3. Fix M1–M3. S2 and S7 are small and should go in with them.
4. Re-run `git branch -r --contains 693f0fa` right before pushing; it must be empty.
