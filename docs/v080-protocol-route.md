# v0.8: the protocol route

One protocol across all platforms. A study's runnable form is now `protocol.json`, run by the Python engine
`hsenv`. The older `package/<slug>/` route stays, read-only, so community studies built before v0.8 still run.

## What changed

**Vendored engine.** `pack/runtime/hsenv/hsenv/{__init__,engine,expr,checks,effects_core,evaldata,rewards,score,
serve,schema_check,distribution}.py`, `schema/{protocol,study,run}.v1.json` and `LICENSE` (MIT) are exact copies of
the public engine, github.com/HumanStudy-Hub/hsenv at tag v0.8.1 (commit db85a9c82f4c7cedeb808a3d39ae2858605d5a20).
- `distribution.py` (since v0.8.1) backs `hsenv.rehydrate`, which rebuilds a protocol from a release projection on
  the user's machine. The app calls it through `pack/runtime/lib/hs_original_text.py` (see "Published studies"
  below).
- Study pins are not in the code. The engine reads a private sidecar only when `HSENV_PRIVATE_CONFIG` names one, and
  the app sets it empty everywhere.
- The engine's `tests/` are never vendored.
- `serve.py` is vendored only because `evaldata.code_hash()` hashes it.
- `skills/run` and `skills/preview` are still synced from the sandbox skills.

`pack/runtime/hsenv/VERSION` names the tag and the commit SHA, the date and the SHA-256 of each file. To refresh,
export the tag (`git -C <hsenv clone> archive <tag> | tar -x -C <dir>`), then run
`scripts/sync_hsenv.sh <dir>/hsenv "github.com/HumanStudy-Hub/hsenv tag <tag>, commit <sha>"` (`STUDIES_DIR` points
the guard at the sandbox's studies folder). Never edit the vendored files by hand.
The script refuses study-specific data (protocols are private). The hard gate is the name of any folder in the
upstream `studies/`, read at sync time, case-insensitive; no folder means no sync. Beyond that it refuses:
- `LEGACY_*` tables written out as data;
- ids shaped like a study (letters plus a year, with or without a topic, any case);
- a study's surname anywhere in a vendored file: code, strings, comments, JSON. Surnames of 4 letters or more
  count everywhere, also as part of an identifier and in CamelCase compounds (`getSurname`, `SurnameItems`).
  Shorter ones count only next to a year or "et al";
- local home paths.

`--check` runs the guard alone and copies nothing (review 4, S3). The
re-synced copy passes it (review 1, M1 closed). The earlier commits of this branch still carry the old copy, so
squash the branch before it is pushed. `pack.ts` installs the engine into `<project>/.opencode/hsenv/` and keeps it at the
shipped version on refresh, like the other app-owned helpers. The engine is stdlib-only; `checks.py` needs Python
3.11+, and the app bundles CPython 3.12. Formerly `rewards.py`, `score.py` and `evaldata.py` were not vendored, because
nothing in the app calls them.

**Project format.** `pack/PROJECT_FORMAT.md` documents `protocol.json`, `study.json` (the project's identity
beside the protocol, not the package's study.json), `sourcetext/`, `review/`, `runs/<stamp>/` and
`variants/<name>/` next to `package/`. It also states that the two forms are checked separately and that a passing protocol.json never makes a
package runnable.
`previous-pack-hashes.json` lists the v0.7.2 hash, so untouched copies in existing projects are upgraded.

**Readiness** (`main/package-readiness.ts`, `main/protocol-readiness.ts`). There are two separate results, never
merged (review 1, M2):
- `ready` is the package route alone, unchanged: the static contract plus `check_readiness.py`. That is the only
  form the agent can run today, so a passing protocol.json never makes a project ready.
- `protocol` (`{ ready, problems }`) is reported beside it when protocol.json exists. It passes when
  `hsenv.checks <project> --sessions 50` passes, with every `sourcetext/*.txt` passed as `--source-text`. Problems
  are listed one line per blocking finding (refs, fuzz, effects, keyed, verbatim, coding, limits).

The protocol checks are confined the same way as `check_readiness`. The engine is written fresh from the app's
bundled copy into a temp folder for each run, never taken from the project's editable copy. Python runs with
`-I -B -X utf8` from an empty home, with only PATH/HOME/TMP set and no keys. Source-text links that lead out of the
project are skipped. The engine runs under bounds, because a protocol's expressions are data an agent wrote:
- 120 s of CPU (`RLIMIT_CPU`);
- 2 GB of memory (`RLIMIT_AS`/`RLIMIT_DATA` where the OS enforces them, and an RSS watch that kills the process
  on macOS, which does not);
- 3 minutes of wall clock.

Stopping at a bound is a blocking `limits` problem and is cached.

The check fails closed:
- with no runtime or no engine configured, the project is not ready;
- without a JSON report that says `"PASS": true`, the project is not ready;
- a report that says PASS but lists a blocking finding is not ready either;
- an engine traceback becomes a `protocol` problem.

Results are cached by input stamp: the metadata, ctime and inode of `protocol.json`, `study.json`, `sourcetext/`,
`sources/`, `assets/` and every local `src` the protocol serves. Runtime problems are never cached, and an edit
made during a check makes it run again. The renderer's `readinessStamp` now covers the same files, so the
Simulation tab rechecks when they change.

**Run approval.** An approval names its route.
- A package approval (`"route": "package"`, or no route as in older approvals) needs the package route
  (`check_readiness` included) whatever protocol.json says.
- A protocol approval (`{"route": "protocol", "protocolHash": sha256(protocol.json bytes), "plan": {...}}`) needs
  the protocol route, never the package. The hash is checked before and after validation, and the relay is capped
  by the runnable arms of the hashed protocol.json (`approvedRunLimits`). Tokens and time are the same per
  participant as for packages.
- An unknown route, or a package approval carrying a protocol hash, is refused.

**Protocol runs** (`skills/run`). `run_study.py`, `fspec.py` and `render.py` are vendored from the sandbox
(`scripts/sync_hsenv.sh run <sandbox/skills>`, manifest `VENDORED`). They are installed in `.opencode/skills/run/`
with the engine in `.opencode/hsenv/`, the sandbox's own layout, so run_study finds the engine unchanged.
The app adds files of its own: `app_run.py` (the run), `protocol_report.py` (`results.html`: people vs AI per
effect and the engine's scores, labelled `offline_report — not a leaderboard`, kit inlined, protocol embedded,
checked offline; plus `summary.json`), `budget.py` and `launch.py`.

**Who starts a run (review 4, S1).** The main process starts it, never the agent. When the researcher presses
Run simulation and the approval passes, `kernel:send` does three things:
1. starts the relay (macOS);
2. creates a new `artifacts/simulations/<stamp>/` with `plan.json` (`"startedBy": "app"`, the approved n and the
   SHA-256 of protocol.json the app read itself) and the run's salt in `<runs>/.operator/`. It refuses when the
   folder's real path leaves the project (a linked `artifacts/simulations`), or when the project holds a
   `variant.json`, which the approval does not cover;
3. writes its trusted copy of the code (`trustedRunFiles()`: the engine, the run skill, `sandbox_run.py`, the
   kit) to app storage outside the project (`userData/protocol-runs/<runId>/`) and starts `launch.py` from it.

`launch.py` runs `app_run.py run` from that copy:
- On macOS it is confined by sandbox-exec (`sandbox_run.run_python`). It writes only to its run folder, reaches
  the network only through the relay port, and hands the capability back when it finishes.
- On Linux and Windows it runs unconfined, with the app's simulation environment, as package runs do there.
- When it exits, its own relay closes, never a later run's (owner-checked, `run-registry.ts`; review 5, M2). The
  per-run code copy is deleted.
- If it ends before writing a final stage, the app marks the run `failed` with the end of `run.log`, so the tab and
  the agent stop waiting. This covers a refusal, a broken runtime or an invalid relay (review 5, S2).
- The run's sys.path is the trusted run skill and engine plus the runtime's site-packages. `-I` keeps the working
  folder, PYTHONPATH and the user site out. The project and the run folder are data, never code.
- The plan is bound (review 5, M1). The main process hands the approved plan to the run in its environment
  (`HUMANSTUDY_RUN_PLAN`): route, protocol hash, n per arm, arms, seeds, temperature. That is what plays. A
  plan.json that differs from it is refused, because any process of the user can rewrite that file.
- After the engine has loaded protocol.json, app_run checks again that its hash is the approved one and that no
  variant was loaded. A swap in between, or a `variant.json` that appeared, ends the run `failed`, and nothing is
  reported from it (review 5, S3; review 6, S2).
- `launch.py` checks the run folder's real path again before making it the sandbox's write root (review 6, S4).
- The per-run code copy is deleted when the run ends. Copies left by a quit or a crash are swept at the next start,
  except for a run that is still going (review 6, S6).
- A test plants agent code in `.opencode/skills/run/`, `.opencode/hsenv/` and `artifacts/simulations/`. None of
  it runs.

**What the approval binds (review 6, S3).** The approval binds protocol.json, its exact bytes, and the plan. It
does not bind the image and asset files that protocol.json points to. Those are read when a screen shows them, and
an image swapped after approval is what the AI participants see. Their hashes are not part of the approval.

**Trust boundary (review 5, S6).** The boundary is the project: the files the agent edits without asking. The
code copy in app storage and the runtime's site-packages are outside it. They are still the same user's files, and
an approved shell command could change them while a run is going. The app does not defend against the user's own
approved commands.

The agent only follows `progress.json` and reports. `app_run.py new` remains only as a manual tool, and the
agent's skill tells it never to start a protocol run.

f is `make_chat_f` over the app's model client (`humanstudy_llm.chat`, so keys stay in the relay), with the
default renderer: one fresh call per page, JSON answers, text only. `run.json` records the model, the renderer and
the protocol's SHA-256. `progress.json` follows the simkit conventions, so the Simulation tab shows a protocol run
like a package run. `records.jsonl` stands in for `sessions.jsonl`.

**Budget (review 2, M3).** The package allowance (40,000 tokens per participant) does not fit a protocol: there is
one call per page, and each prompt carries every earlier page and answer.
- When protocol.json passes its checks, the app measures the run's budget with `skills/run/budget.py`. It runs
  confined, from the app's own copy, like the checks. It plays three random+gates participants per arm through
  run_study and counts what the default renderer would send: bytes + 256 per message + 512 output per call. It
  keeps the largest member per arm, adds a 1.5x margin and records group sizes.
  - The fixture needs about 4,700 tokens per participant, a 33-page survey about 180,000, and a 4-person game
    about 2,000,000 per member.
- The measurement counts each call's exact request body as `humanstudy_llm.chat` serialises it: JSON with
  `ensure_ascii` on, so a CJK character costs 6 bytes, not 3. Newlines and quotes are escaped too (review 3, M2).
- `protocolRunLimits` (shared) turns the budget into the relay's cap: per arm × group size × tokens per member,
  plus a one-per-arm trial. It is capped by the hard ceiling of 16,000,000. Minutes come from the calls.
- The Simulation tab shows the figure ("Model budget") and sends it as `plan.tokenBudget`. The main process
  recomputes it and refuses any other number, or a plan over the ceiling.
- The run uses `retries` 0 (humanstudy_llm already retries 429/5xx), so a call that still fails ends that
  participant as incomplete.
- `app_run` marks the run `partial` unless every planned participant finished without a failed call. Progress
  becomes `failed` with "Partial run: k of n …". The page carries "PARTIAL RUN — not the planned n" and
  summary.json says `not_ready`.

**Binding and stop (S6, S7).** A package run's relay descriptor carries the approval's `route`, the SHA-256 of
protocol.json as the app read it at approval, a fresh `runId` and `approvedAt`. run_confined.py hands them to the
run.

A protocol run's relay writes no descriptor (review 5, M3). The app hands the capability to `launch.py` directly,
so the agent never holds that token and cannot spend it or end the run with `/run/complete`.

One leak remains: `launch.py` and the confined run hold the token in their environment from the start, and on
macOS a process of the same user can read another process's environment (`sysctl KERN_PROCARGS2`). Closing it
would mean passing the token on a pipe; that is not done.

The binding checks:
- `app_run` refuses a package-route capability or another protocol version;
- simkit refuses a protocol-route capability;
- a stopped run (STOP or progress `stopped`) restarts only under an approval given after the stop, recorded in
  `plan.json.resumedAfterStop`. STOP is never deleted otherwise.

The agent cannot forge the descriptor. Since review 4 (S1) the code that checks it and computes the scores also
runs from the app's trusted copy, not from the project. `refreshAppOwned` still puts the project's `.opencode` copy
back at the shipped version before every approved run. That keeps the agent's own tools honest. It is not what
binds the run: an agent could edit that copy again afterwards.

On macOS the relay's token cap is the hard bound on spend. On Linux and Windows there is no relay and no cap: the
run uses the signed-in key, as package runs do there. The run confirmation says the study code can read the key.
Its "Model budget" row reads as an estimate there ("nothing enforces it: the run is bounded by the participants per
arm") rather than as a figure the researcher approves (review 6, S5). Spend there is bounded by the exact n: no
top-up and no f retries. The app allows one protocol run
per project at a time, and holds that claim until the run's process exits (review 5, S5).

**One runner per run folder (review 3, S2).** `app_run` takes an OS lock on `<run>/run.lock` for the life of its
process (fcntl, or msvcrt on Windows), with its pid and start time written in.
- A second start under the same approval or a new one refuses while the first process lives.
- Each approval from the Simulation tab is a new run in a new folder. Stop followed by Run starts a fresh run,
  and the stopped folder keeps its partial data. A stopped folder resumes only when someone restarts it by hand
  (`app_run.py run`) under a new approval. That resume waits up to 120 s for the stopped process to exit, then
  runs. A Stop is dated by when the researcher asked (`stopRequestedAt` = STOP's time, written into progress.json
  with `stopped`), not by when the stopped process finished writing (review 4, M1).
- The lock is released however the process ends.

**Private engine config (review 3, S4).** `HSENV_PRIVATE_CONFIG=''` is set on every desktop path: the readiness
gate, the agent's environment (kernel), run_confined (relay and unconfined), simkit `start`, and `app_run.py`,
`budget.py` and `make_preview.py` before any engine import.

**Stop.** The researcher's Stop writes STOP into the run folder through `project:writeText`, and the main process
then closes every run relay of that project at once (`run-stop.ts`, which matches projects by real path), so no further model call can succeed. The run
ends after the pages in flight, with stage `stopped`:
- `run.json` `app` records what finished;
- `partial.jsonl` records each participant that was still in progress, with status `partial`;
- no comparison or results page is drawn from a stopped run.

**Protocol-only projects.** A project with protocol.json and no program.json opens the Simulation tab. The tab reads
a view-only program built from the protocol (`shared/protocol-program.ts`): one study, the runnable arms as
conditions and the paper's n as the sample. It is never written to disk. Readiness for such a project checks the
package route without a program and decides runs by the protocol route alone. A protocol run is gated by the
protocol's checks and its budget, not by the program's section 12.

On Linux and Windows there is no relay. There, only plan.json's hash and STOP are checked: a stopped run is never
resumed.

**Headline (review 3, M1; UX re-check).** The Simulation tab's headline for a protocol run follows `hsenv.score`,
not the sign table, and never says more than the text:
- a partial run shows "The comparison could not be made";
- a run that is not official by the strict definition (official plan, verified human n and a complete run) shows
  the neutral "Finished" / "已完成". That covers a different n from the paper, the usual case, and also the paper's
  printed n when it is not verified;
- a strictly official run takes its headline from the same per-comparison direction count as the paragraph
  (UX round 3). It is never worded as "showed the effect":
  - every comparison in the paper's direction, with the engine's direction check passed: "Same direction as the
    paper";
  - every comparison in the paper's direction, with the check failed (it fails only on significance): "Same
    direction as the paper, but not significant in this run". This one is neutral, not red;
  - some comparisons in the paper's direction and some not: "Mixed: k of n comparisons in the paper's direction";
  - none in the paper's direction: "Direction differs from the paper".

The same rule (`headline()` in `shared/simulation-run.ts`) applies to any summary with structured facts in the tab.

A partial run never shows `done`. The app holds run_study's own `done` back, writes `failed` before it builds the
page, and keeps `failed` if the page cannot be written. A partial page shows no pass/fail: each reward reads "no
verdict (partial run)" and the text report is left out. The token cap is detected by `HTTP 402` or "token cap", not
by any "402".

**Relay refunds (review 4, S5; review 5, S1).** The relay gives a call's reservation back only when the provider did
not process it, and logs a `refunded` event:
- a 400, 401, 403, 404, 413, 422 or 429 answer;
- a connection refused or a name that does not resolve.

A 500, 502, 504 or a timeout may come after the model ran and billed, so it is never refunded. Total refunds per
run never exceed the cap.

**What the researcher sees (UX check, 0.8.0-beta.1).** The owner's rules apply: agent-first, minimal UI, jargon
hidden by default, zh and en.
- **The Simulation tab.**
  - No token figures are shown. The budget row reads as a time limit ("a fixed limit … at most N minutes";
    without a relay, an estimate that nothing enforces). Token numbers sit behind the existing Details disclosure
    (`sim.relay_detail`).
  - Signed out, Run is disabled and says "Sign in to run a simulation." The tab never points to a chat reply that
    cannot exist.
  - After Stop, one line says how far the run got.
  - Partial or failed runs that wrote a results page stay listed.
  - A project with only protocol.json opens on this tab.
- **The results page** (`protocol_report.py`) is written in the app's language (en, zh-CN; the approval carries it
  to the run as `HUMANSTUDY_LANG`).
  - Its visible part is plain: a banner ("… not a leaderboard"), a paragraph, and the comparison table with plain
    names and metrics.
  - The engine's scores and "What ran", with every code string, are collapsed under "Technical details".
  - The page says "official" only when the plan is official, the paper's n is verified and the run is complete.
    Otherwise it says "unofficial" (zh: 非正式), and a partial run is never official.
- **The card and the headline.**
  - The card builds its paragraph from the summary's structured `facts` with i18n keys.
  - A direction headline appears only on the strict official comparison (see Headline); otherwise it is
    "Finished".
  - A partial run says why ("10 model calls failed", "used up its approved model limit") and what to do next
    ("press Run simulation to run it again").
  - The technical section is translated too, and it never says "official" outside the strict definition.
- **Elsewhere.** app_run's progress messages follow the app's language, the version is 0.8.0-beta.1, and "Check for
  updates" is translated.

**Like with like (S8).** The results page compares directions only when the paper's metric is the engine's metric:
cells give a risk or mean difference, then an estimate in the same metric, then a printed value with its stated
metric. Unsigned metrics (phi, Cramér's V) are not compared by direction. Anything else shows
"not compared (different metric)".

**Scores (S9).** With `evaldata`/`rewards`/`score` vendored, run_study scores every run through
`hsenv.score.summarize` and writes `evaldata.json`, `rewards.json` and `run.json` `evaluation.rewards`. The results
page shows these values and does not recompute them:
- each reward's value and verdict;
- its labels: offline_report, official or non_official, a verdict on an unverified human n, intention-to-treat
  unchecked or not applicable, the view;
- the counts of not-computable items with their reasons;
- the plan's human n basis;
- the engine's text report.

The people-vs-AI direction table stays as a reading aid. Two choices in `app_run`:
- the floor baseline's cache is kept inside the run folder (run_study puts it beside the run folders, where the
  macOS sandbox cannot write and the Simulation tab would list it as a run);
- `top_up` is off, so a run plays exactly the approved n that the budget was measured for. Excluded sessions are
  scored by the engine's rules and not replaced.

The Simulation tab prefers the protocol route when protocol.json passes. It sends a protocol approval, shows the
arms as the conditions and caps the confirmation by them. When protocol.json does not pass, it lists the protocol's
problems.

**Preview** (`skills/preview`). `make_preview.py` (the app's) runs the vendored `build_preview.py`, embeds the
protocol's identity and checks the page with the kit. The output is `artifacts/preview.html`, an artifact card.

`inline.py` has a protocol mode, used for a page with `<meta name="hs-artifact" content="participant-preview|protocol-report">`
or with `--protocol`:
- it embeds `<script id="hs-protocol">` (id, SHA-256, arms, stages and effect ids; never screen text) instead of
  the program;
- `data-program-id` must be a protocol ref;
- a participant preview keeps its own styles and script, so the kit is not injected;
- the offline rules are unchanged.

`build_preview.py` finishes the page through the same step on both paths, the sandbox CLI and `make_preview.py`:
`finish()` embeds the protocol block and runs the kit's protocol-mode check. It finds the kit via
`HS_ARTIFACT_KIT` or a sibling `artifact-kit/`, and falls back to the kit's offline check with an older kit.

**Build progress / results.** `buildPhase` maps writes to `protocol.json`, runs of `build_protocol.py` and runs of
`hsenv.checks` to the "Make it runnable" phase. `checkResult` reads the top-level `"PASS": true|false` line of an
`hsenv.checks` report and gives no verdict on a crash or on a grep of the checker. `results.ts` shows
`protocol.json`, `runs/` and `variants/` as simulation cards. `sourcetext/` and `review/` appear as reports.

**Tests.**
- `main/protocol-readiness.test.mjs` (new): report parsing, fail-closed cases, source-text confinement, and the
  real bundled engine on a synthetic fixture (`main/fixtures/protocol-mini/`, not a real study, because protocols
  stay private). The engine passes a sound protocol and blocks an unreached stage and a broken flow.
- `shared/package-readiness.test.mjs`: the either-route rule, refusal of approvals, the cache, fail-closed
  behaviour, and the renderer stamp.
- `main/run-approval.test.mjs`: protocol caps.
- `main/pack.test.mjs`:
  - the vendored files match VERSION/VENDORED and are installed and restored;
  - a protocol run with a stub f end to end in an installed project (trial, full run, records, effects, results
    page passing the kit checks, summary, no arm in records);
  - inline.py's protocol mode;
  - the preview build of the fixture, checked in protocol mode.
- `shared/simulation-run.test.mjs`: records.jsonl counts as a run's participant data.
- `paper-build` and `ux` tests: the new regexes.

## Published studies: original wording (hsenv 0.8.1 link + hash)

A published protocol.json (a release projection) holds placeholders where wording from a non-redistributable source
goes (`distribution.held`: path, source, length, `text_sha256`, locator). The app fills it in on the researcher's
computer:
- **Where.** `main/original-text.ts` runs `pack/runtime/lib/hs_original_text.py` from the app's own copy, with the
  bundled engine, isolated like the checks (-I -B, empty home, no keys; proxy settings only), when the project
  opens, after a file is dropped into it, and as part of readiness (`package-readiness.ts`, lane `text`, cached by
  protocol.json + sources/ + paper.pdf and kept at most ten minutes, so a failed download is tried again; the helper
  itself waits ten minutes before asking the publisher again, and drops a download that restored nothing, such as
  a sign-in page).
- **How.** Link-tier sources are downloaded (http(s) only, no https→http redirect, no local or private addresses
  for the URL or any redirect (a DNS answer that changes after the check is not caught), 100 MB cap); the rest are tried from `sources/private/`, `paper.pdf` and `sources/` (best first: named after the
  source, then the builder's file sha256, then any file of the format). Each item is accepted only when its text
  hashes to `text_sha256` (hsenv's rule), so a wrong file can only leave a screen empty. PDF needs pypdfium2, which
  the runtime has (pinned in requirements.lock via pdfplumber); without it PDF sources say so and text, HTML,
  docx and QSF sources still work. Held pictures (and regions rendered as pictures) are not supported yet: such a
  study stays unresolved with need `picture`.
- **What stays local.** Downloads and the restored protocol live in `<userData>/original-text/` (per
  sha256 of protocol.json), never in the project, so neither exports nor research capture see them. A file dropped
  into a published study goes to `sources/private/` (never exported or collected) and never becomes paper.pdf. The
  project gets `.humanstudy/original-text.json`: counts, titles, formats and what each source needs, no wording.
- **Run.** Missing wording is a blocking protocol problem (the Simulation tab words it, en and zh), The engine checks
  of a published study get, for each held source without its own sourcetext/ file, a source text that is one run of
  placeholders as long as its longest held text: by the engine's own verbatim rule every held placeholder is found
  and any other text cited verbatim from that source is not, so it still blocks (no rule in the app decides which
  texts are excused). Once the wording is restored, the checks run again on the restored copy in app storage (held
  texts checked against themselves, after their hash check), and any finding blocks, reported by check name only.
  The held list (`distribution`) is pinned in app storage the first time the study is seen; an edited or removed
  list blocks the run (download the study again). An
  approved run copies the restored protocol into its trusted code folder (`restored/protocol.json`); app_run reads
  it from beside its own code (never from the environment) and plays it only if every held text hashes to its
  `text_sha256`, no placeholder is left and nothing else differs from protocol.json. It records the approved
  (published) hash and keeps no screens in records.jsonl (`states="none"`). Without it app_run refuses a published
  study.
- **Preview.** make_preview.py shows "[text not available]" (zh: "[文字不可用]") for held texts; it never uses the
  restored copy.
- **Agent.** `skills/run` "Original wording" tells the agent how to read the status and what to say, and never to
  open a file in `sources/private/` or the app's `original-text/` storage; AGENTS.md says the same. A drop into a
  published study tells the agent the file was received to fill in the wording and not to open it. Research capture
  redacts the input and output of any tool call (and any raw part) that names those paths
  (`telemetry-core.ts` `redactPrivatePart`), before anything is stored or put in a blob.
- **Downloads** also stop after 90 s each (150 s for all of one check), write the failure marker on a timeout, treat
  a web page returned for a non-HTML source as a failed download (a sign-in or paywall page), and never fetch a host
  that does not resolve here.
- **Follow-up (hsenv 0.8.2 / sandbox skills/run).** `run_study.load_protocol` (vendored) cannot be guarded here:
  the guard against placeholders is in app_run (it refuses any protocol with runs of placeholders and no restored
  copy). Upstream, `run_study.load_protocol` (or `hsenv.engine.Protocol.load`) should refuse a protocol with a
  non-empty `distribution.held` or runs of U+2591, and `checks.check_verbatim` should report the paths it counts as
  unchecked, so the app can excuse exactly the held paths without the placeholder source text.

## Not done (next)

1. **History.** Squash this branch before pushing: commits before the engine re-sync carry the old engine
   copy with study ids.
2. **MCP export.** Expose `protocol.json` + engine through the agent-package MCP server (`skills/export/agent`), so
   other platforms run the same protocol.
3. **Build skill.** Teach `skills/build` to write `protocol.json` and `sourcetext/` and run `hsenv.checks`. The
   paper-build certificate is still `program.json`-based, so a protocol-only build does not count as complete.
4. **Images.** The gate does not pass `--fetch-images` (no network in the gate). A protocol that serves remote images
   is not image-checked by the app; the converter's own 1,000-session gate must have done it.
5. **Two `effects_core.py` copies.** Left unchanged on purpose. The desktop copy (`skills/export/agent`) is the
   source of Bench's copy. The engine's copy is a strict superset: it adds the ops `spearman`,
   `proportion_vs_chance`, `smd`, `interaction` and `rank_sum` (with `_ranks`), extends `OPS` and `OP_FUNCS` to
   match, and `compute()` also catches `OverflowError`. Every other function is identical. The owner decides which
   is canonical.
