ready

Review 6 of `claude/protocol-route` at HEAD `2498034` (worktree hsd-protocol-route). I checked every item of review 5 against HEAD and read the whole of `2498034`: index.ts (`kernel:send`, `startProtocolRun`, Stop, abort), run-registry.ts, protocol-run.ts, model-relay.ts, app_run.py, launch.py, protocol_report.py, sync_hsenv.sh, the i18n rows, the doc and the new tests. I also read the code these call: run_study.py (`resolve_study`, `load_protocol`, the asset copy), the engine's `asset_ref`, `sandbox_run.run_python`, run-approval.ts, run-stop.ts, the Simulation tab's confirmation, Workbench's approval builder, and the hosted chat route on the web repo's `origin/main` (read only). Everything I ran is in my scratch folder. The only file I wrote in the worktree is this one; `git status` is otherwise unchanged.

Probes:
- **Sync guard.** `--check` passes on the vendored engine, schemas and skills at HEAD, and on the upstream engine and skills, with STUDIES_DIR set to the real upstream studies folder. I planted ten forms of one real 5+ letter surname, one form per run. Refused: `get<Surname>`, `<Surname>Items`, `<surname>_items`, `<SURNAME>_ITEMS`. Passed: `<surname>Score` (lowerCamel), `<SURNAME>Items`, `ID<Surname>`, `get<surname>items`, `<Surname>s`, `<Surname>ian`. See S1.
- **Hosted refund statuses.** The hosted route passes OpenRouter's status through unchanged. Its own early answers (401 key, 413 body, 400 JSON or model) all come before any upstream call.
- **Hygiene.** I scanned the added lines and message of `2498034`, every file changed since `0d9343f` at HEAD, and the untracked review docs. The scan looked for upstream folder names, surnames (3+ letters), id shapes and home paths. I record counts and file:line only.

Tests (keys unset; node 22 x64; Python /usr/local/bin/python3 3.13):
- App suite, CI's file list minus live, native-live and runtime: 286 tests, 284 pass, 0 fail, 2 skipped. The skips are the web-contract comparison and T11. All seven new or changed review-5 tests ran and pass, including the macOS confined protocol run.
- `npm run typecheck`: clean.
- `scripts/tests`: 15 tests, 1 failure (`test_prepare_conversion`, malformed-program check). It also fails on main.
- `pack/runtime/tests`: 556 tests, 2 errors (`jsonschema` missing, environment), 31 skipped.

Every must-fix from review 5 is fixed, and every should-fix is fixed or covered in the doc. The plan that plays now comes from the approval the main process checked, not from a project file. Relays and project claims are removed by owner. A protocol run's token is never written where the agent can read it. I found no new must-fix. What remains: one guard gap (lowerCamel), two places the binding still leaves a gap (a variant created mid-start, and asset files), one UI line that implies a cap on Linux and Windows, and housekeeping. None of it lets the agent spend beyond the cap on macOS or produce a verdict labelled as an official original run that is not one. The token-in-env residual is acceptable for a beta (reasons at M3 below).

## Review 5 findings vs code

- **M1 (plan not bound): fixed.**
  - The plan comes from the approval. `startProtocolRun` builds it from `approved.plan.perCondition`, checked 1–60 (`index.ts:701-709`). That value is parsed from the `kernel:send` text, which only the renderer's Workbench approval builds (`Workbench.tsx:76`). The same object feeds `approvedRunLimits`, so the cap and the n come from one value. Arms (`null`), seeds (`[1]`) and temperature (`1.0`) are constants in the main process, so no project file decides them.
  - The main process puts the plan into the child's environment at spawn (`protocol-run.ts:92`). `launch.py` forwards it (`launch.py:35`). The agent cannot write into another process's environment, and the plan is fixed before any of the agent's processes could see the run.
  - `approved_plan` refuses a plan.json that differs on any of the six keys, then plays the env values (`app_run.py:105-124`). The later rewrite of plan.json keeps the approved values and adds only `runIds` / `resumedAfterStop` (`:340-342`).
  - Tests: the app path test edits plan.json after launch and gets `failed` with "not the approved plan" and no records (`protocol-run.test.mjs`). The unit test refuses 7 × 3 seeds (`pack.test.mjs`).
  - Nit: when the binding env is present but `HUMANSTUDY_RUN_PLAN` is missing, app_run falls back to plan.json (`app_run.py:114-115`). The app always sets it, so this is not reachable from the app. Refusing when `bound` is set and the plan is missing would close it for good.
- **M2 (old exit closes the new relay): fixed.**
  - `RunRegistry` (`run-registry.ts`) removes by owner. `forget(id, close)` acts only if `close` is still the session's relay, and `release(project, owner)` only if `owner` still holds the project.
  - The protocol run's `onExit` forgets and closes its own relay (`index.ts:758`). The relay's `onClose` forgets its own entry and releases its own claim (`:752`).
  - The two-runs-on-one-session test passes (`run-registry.test.mjs`).
- **M3 (protocol capability handed to the agent): fixed.**
  - `publish: route !== 'protocol'` (`index.ts:751`) and `if (options.publish !== false) writeFile(...)` (`model-relay.ts:151`). The project's old descriptor is still unlinked first, so no stale protocol descriptor is left behind.
  - The token goes only into launch.py's env. The confined child's `HUMANSTUDY_DESKTOP_KEY` is the relay token, never the real key.
  - Not done: run_confined refusing a protocol descriptor. That is moot while none is ever written.
  - The residual is documented (`v080-protocol-route.md:150-152`).
- **S1 (refunds of billed calls): fixed.**
  - Refunds are limited to `NOT_PROCESSED` = 400/401/403/404/413/422/429 (`model-relay.ts:49`, `:115`), plus ECONNREFUSED/ENOTFOUND/EAI_AGAIN in the catch (`:132`). 5xx and timeouts are logged `failed` and keep their reservation.
  - Total refunds are kept within the cap. So the worst case is 2 × cap reserved, and only if refunded calls were billed, which these statuses rule out.
  - A client cannot fake a status: the status is the upstream's, and the hosted route passes OpenRouter's through. A client can only provoke a 4xx that costs nothing.
- **S2 (early death unreported): fixed.**
  - `markEnded` writes `failed` with the run.log tail when the exit code is non-zero and progress.json has no final stage (`protocol-run.ts:49-58`, `:102`).
  - `launch.py` now logs refusals and exceptions to run.log (`launch.py:77-94`).
  - A signal (code `null`) and the launcher's time limit are covered too. Test: the invalid relay ends `failed` with "invalid model relay".
- **S3 (TOCTOU on protocol.json, variant): mostly fixed.**
  - The post-run check compares `meta.protocol_sha256` (hashed from the bytes the engine parsed, `run_study.py:171-172`) with the approved hash (`app_run.py:367`).
  - A variant is refused twice: by the app (`protocol-run.ts:71`) and by app_run (`app_run.py:132`).
  - Gap: a `variant.json` created after `check_approval` and before `resolve_study` is not caught (Should-fix S2).
- **S4 (run folder outside the project): fixed, with a narrow window.**
  - `checkInside` compares the realpath of `artifacts/simulations` with the project's realpath (`protocol-run.ts:39-44`). `mkdir(runDir)` is non-recursive, so the folder is always fresh. The symlink test passes and writes nothing outside.
  - Window: see S4 below.
- **S5 (no guard on the pre-relay path): fixed for app-started runs.**
  - `runs.claim` happens before the start, and the claim is released on the launcher's exit (`index.ts:768-771`).
  - The doc now says there is no cap on Linux and Windows (`v080-protocol-route.md:165-167`).
  - Not covered: the claim lives in memory. A detached Linux run outlives an app restart, and after the restart a second run is allowed beside it. The agent can also still start its own unconfined runs there, which is the documented pre-relay posture.
- **S6 (trust boundary, copies accumulate): fixed.**
  - The boundary paragraph is in (`v080-protocol-route.md:108-111`).
  - The per-run copy is removed on exit (`protocol-run.ts:103`), tested.
  - Leftovers: copies from an app quit or crash are never swept. And the paragraph is inserted between two bullets of a list, so the "A test plants agent code …" bullet (`:112`) now sits under "Trust boundary". Move it up.
- **S7 (doc: resume and outcome): fixed** (`v080-protocol-route.md:172-176`).
- **Review 4 S2 wording nit: fixed.** The headline reads "(paper's printed n, not verified; engine check)" (`i18n-dict.ts:161-162`). The paragraph reads "On the paper's printed n, not verified (no analysed n in …)" (`protocol_report.py:146`). Both are tested.
- **Review 4 S3 guard CamelCase suggestion: partly fixed.** `camel_rx` (`sync_hsenv.sh:47`) catches `get<Surname>` and `<Surname>Items`. It misses lowerCamel compounds (S1 below).

## Must-fix

None.

On the documented residual (the relay token in launch.py's and the confined run's environment, readable by a same-user process through `KERN_PROCARGS2` on macOS): **acceptable for this beta, not a must-fix.** Reasons:
- What it exposes is a run-scoped relay token, not the key. It allows at most the approved token cap. It dies when the run exits, when Stop is pressed, or at its lifetime.
- Reading it needs the agent to run code that calls sysctl on the run's pid, not a file read.
- The worst outcomes are spending within the cap the researcher approved, or ending the run early through `/run/complete` (a partial run, labelled as such).
- Neither is worse than what the agent can already do to the run folder inside the project. That folder holds the outputs, which the agent can rewrite as the user, as the trust-boundary paragraph already concedes.

Close it after the beta: pass the token to launch.py on an inherited pipe fd or on stdin, and have the confined boot set it into `os.environ` before importing humanstudy_llm.

## Should-fix

- **S1. The guard misses lowerCamel surname compounds.**
  - `<surname>Score` / `<surname>Data` pass. `long_rx` needs a non-letter after the surname, and `camel_rx` needs it capitalised. This is the commonest way a variable gets named after a study, so it is the likeliest real miss after review 5's.
  - Add `(?<![A-Za-z])(surname)(?=[A-Z])` case-sensitive on the lowercase form.
  - Optionally drop the `(?<![A-Z])` lookbehind so that `ID<Surname>` and `<SURNAME>Items` are caught too. With `re.I` dropped this becomes `(?<![a-z])SURNAME(?![a-z])` on the upper form.
  - Today HEAD's vendored code scans clean, so this only guards future syncs.
- **S2. A variant created mid-start is not caught after the run.**
  - `check_approval` checks `variant.json` (`app_run.py:132`), but `resolve_study` reads it again later (`run_study.py:161`). The post-run check compares only the hash (`app_run.py:367`), and a variant leaves protocol.json's hash unchanged.
  - The run would then be labelled "not the original experiment". It would also read assets from the variant's `study_dir`: inside the sandbox's read set on macOS, anywhere on Linux and Windows.
  - Fix: also require `meta.get("variant") is None` in the post-run check.
- **S3. Asset files are not part of the binding.**
  - The approval hashes protocol.json only. The engine resolves `asset:` sources to files in the study folder (`engine.py:85-106`) and copies them when a screen shows them (`run_study.py:413-431`).
  - An image the agent swaps after approval is what participants see. The hash is computed lazily, and nothing compares it with approval time.
  - This is integrity, not money. Either include the referenced assets' SHA-256 in the approval hash and re-check them as protocol.json is re-checked, or say in the doc that the binding covers protocol.json only.
- **S4. Close the check-then-use window on the run folder.**
  - `checkInside` resolves `artifacts/simulations` before `mkdir(runDir)`, the plan.json write and the salt write (`protocol-run.ts:80-88`). `launch.py` then resolves run_dir again and makes it the sandbox's write root (`launch.py:30`, `:51`).
  - A link swapped in between moves a fresh, empty run folder (and plan.json and the salt) outside the project. The impact is small: the names are fixed and the folder is new. But it is cheap to close: in `launch.py`, refuse unless `run_dir` is inside `project` after `.resolve()`.
  - `markEnded` writes progress.json at exit through the same path again. Same impact.
- **S5. On Linux and Windows the confirmation still shows "Model budget … Run approves this figure"** (`SimulationPanel.tsx:308-311`, `i18n-dict.ts:76`). Nothing there enforces it. The note (`sim.note_key`) says the code can read the key, not that the budget is not enforced. The doc's "The run confirmation says so" (`v080-protocol-route.md:166`) is therefore only half true. Spend there is bounded by the fixed n (exact n, no top-up, no extra retries), not by tokens. Word the row as an estimate when `RELAY` is false, or add a clause to `sim.note_key`.
- **S6. Housekeeping.**
  - Sweep `userData/protocol-runs/*` at startup. Copies from a quit or crash are never removed, and the main process can tell a live run by its claim.
  - Move the misplaced bullet in the doc (see review 5 S6 above).

## Checked and correct

- **Where the plan comes from.** The plan is built in the main process from the approval message and the main process's own constants. No file in the project is read for n, arms, seeds or temperature. The cap is computed from the same `perCondition` and the hashed protocol.json. A forged count over 60 is refused in both `approvedRunLimits` and `startProtocolRun`.
- **Registry races.**
  - Stop: the STOP write calls `closeProjectRelays` → `closeCurrent`. The relay's `onClose` frees the project, so Run again starts B. A's late exit then forgets and closes only A.
  - Abort during launch (`kernel:abort` → `closeCurrent`, `index.ts:842`) closes the relay before the child spawns. The child then fails against a dead relay and is marked `failed`. Nothing is spent, and the late `ended` callback is owner-checked.
  - A second approval on the same project while the first holds the claim is refused before any relay starts. A failure after the relay started closes it and releases the claim (`index.ts:759`).
- **Refunds.**
  - The relay checks `reserved + charge > cap` synchronously before reserving, so concurrent calls cannot oversubscribe.
  - The refund is limited both by status and by the running total.
  - A failure after `upstream.ok` (bad JSON) is not refunded, which is the safe side.
  - The test covers 429 refunds stopping at the cap, 502/504 not refunded, and ECONNREFUSED refunded.
- **Hash re-check after load.** `psha` is the SHA-256 of the exact bytes `Protocol` parsed. On mismatch the run ends `failed` with no results.html (tested). The check runs before the stopped and partial branches, so no swapped run can report.
- **Code-copy cleanup timing.** `rm(codeDir)` runs only after launch.py exits. launch.py exits only after `run_python` returns, which waits for the confined child or kills its process group on timeout (`sandbox_run.py:354-369`). On the pre-relay path, `subprocess.call` waits too. A copy is deleted under a live run only if someone kills launch.py itself. That needs a process of the user and affects only that run.
- **No descriptor on the protocol route.** The test asserts ENOENT. The agent's `HUMANSTUDY_RELAY_DESCRIPTOR` path is empty for the life of a protocol run.
- **Linux and Windows one-run claim.** Same registry, claim before start, release on exit and on every throw path. A spawn `error` also reaches `end(null)`, which releases the claim.
- **Early death.**
  - A refusal before progress.json, an invalid relay, the run lock, a sandbox 126, an ImportError, a spawn error and a time-limit kill all end with a non-zero or null code, so they are marked `failed`.
  - A run that wrote `stopped`, `done` or `failed` itself is left alone.
- **Hygiene of HEAD.**
  - `2498034`'s added lines and message: no folder name, surname, id shape or home path.
  - Files changed since main: surname hits only in `i18n-dict.ts`, `package-readiness.test.mjs` and `simulation-run.ts`, all on lines unchanged from main (the public sample). Id shapes only in pack.test.mjs's made-up fixtures and the guard's comment. Home-path hits only in the guard regex and a code comment.
  - `git branch -r --contains 693f0fa` and `… 2498034` are both empty.
- **Tests.** See the counts above. The one `scripts/tests` failure predates this branch.
- **Runtime tests (`pack/runtime/tests`).** 556 tests, 2 errors, both `No module named 'jsonschema'` (environment), 31 skipped. This matches review 5.

## Before push

1. **Squash `0d9343f..HEAD` (now 11 commits, `693f0fa` … `2498034`) into one.**
   - `693f0fa` adds the vendored engine with folder names, surnames, id shapes and a home path. `beb24ff` adds a surname comment. Every later commit carries that engine in its tree.
   - After squashing, grep `git log -p origin/main..HEAD` for the folder names, the surnames, `[A-Za-z]{2,}(19|20)\d\d[A-Za-z]*` and `/Users/`. The only hits should be the made-up fixtures in pack.test.mjs, the guard's own text and the lines unchanged from main.
2. **Keep the review notes out of the commit.**
   - `docs/review-protocol-route-1.md` has 9 folder names, 9 surnames, 8 id shapes and a home path. `-2.md` has 10, 10 and 8.
   - `-3`, `-4`, `-5` and this file name no study; their only hits are generic path mentions and the regex.
   - Keep all six out unless the owner wants them public.
3. S1 (guard lowerCamel) and S2 (variant post-check) are a few lines each and worth putting in the squash. S3–S6 can follow the beta, with S3 and S5 at least stated in the doc.
4. Re-run `git branch -r --contains 693f0fa` right before pushing; it must be empty.
