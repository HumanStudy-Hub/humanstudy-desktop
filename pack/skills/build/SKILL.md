---
name: build
description: Turn the project's paper.pdf (and any authorized open materials) into a schema-valid Human Program v2 program.json, a runnable replay package that agents can execute, and capabilities.json (what the study can and cannot do). Use when a project has a paper but no program, or the researcher asks to (re)build the study or make it runnable.
---

# Build: paper → program.json → runnable package

Follow every rule in `AGENTS.md`. Never invent study facts. The goal is a study that an agent
can actually run as the original participants did, so the researcher can check it and simulate it.

## 1. Read the sources

- Extract text from `paper.pdf` page by page with `hs-pdf pages paper.pdf` (prints one
  `=== page N ===` block per page; add `--from N --to M` for a range, `--layout` for column-aligned
  tables). `pdftotext -layout paper.pdf -` and `pdfinfo` also work (form feed between pages). If
  `hs-pdf` reports pages with no text, the PDF is scanned. There is no OCR tool; if you can view a
  page as an image (some agents can read PDF pages or images directly), read the scanned page,
  and above all its tables, from the image. Pages you cannot see are listed as unreadable, never
  guessed. Keep the physical page number of every passage you may cite.
- Copy words (quotes, `verbatim` fields) from the plain text, never from `--layout` output: the
  column-aligned text splits words ("correspon dence", "l ateral") and pads them with spaces.
  `--layout` is for seeing which cell of a table is in which column. `check_verbatim.py` compares
  every verbatim field with each raw text reader and fails on such splits.
- List every table the paper prints (caption and page) while reading: each is transcribed in step 2.
- Record the source files once you have read them: `python .opencode/skills/build/sources.py .`
  writes `sources/SOURCE.json` (path, SHA-256, size, license of `paper.pdf`, every file in
  `sources/` and every file evidence cites). It reads the license the PDF prints about itself ("This
  article is licensed under a Creative Commons Attribution 4.0 International License", often on the
  last page or a first-page footer) and records it with the page and sentence; check what it printed.
  Otherwise the license is `unknown` unless the file states one in words the script does not
  recognise: then add `--license paper.pdf=CC-BY-4.0 --license-evidence "paper.pdf=p. 1: <the printed line>"`.
  Never guess a license. Rerun it whenever a source file changes; the package check requires it, and
  `--check` fails while a PDF that prints a license is recorded as `unknown`.
- Read `sources/` only if present. Use the network only for URLs the researcher explicitly gave, and to
  search for public materials of this paper that it does not print ("Materials the paper does not print"
  below); record each URL consulted in `source/paper_metadata.json` → `external_sources`.
- List every empirical study in the paper before modelling any of them.

## 2. Write program.json (the Study document)

**Save in checkpoints, so the researcher sees the study as it is extracted.** Once the study
map is known, write a first batch (top level `schemaVersion: 2`, `id`, `title`, `source`, `intent`,
plus `studies` and the overview/question nodes with their evidence) as JSON with the write tool to
`.humanstudy/tmp/batch-01.json` and apply it:

```bash
python .opencode/skills/build/program_io.py .humanstudy/tmp/batch-01.json
```

Continue with small batches (`batch-02.json`, …), for example one section or one study at a time,
each with the evidence its records cite. `program_io.py` merges records by `id`: a record sent
again updates the fields it contains, and records not in the batch are kept. It writes
`program.json` under a shared save lock and atomically, so a failed batch never damages the saved one. Never write the whole
program in one tool call. An import build is already authorized: do not ask whether to start.

Validate against `schema/human-program.schema.json`. Work in this order:

1. `source`, `studies` (with `dependsOn` where a study consumes another's outputs), `intent`.
2. `evidence`: one record per cited passage, `locator.page` + exact `quote` copied from the
   extracted text. Preserve the complete relevant sentence(s), or the whole paragraph when its
   conditions, qualifications or context are needed to support the claim. A short keyword fragment
   is a locator, not sufficient evidence for a research decision. Do not shorten quotations to save
   tokens. Use several evidence records when a claim depends on separate passages, and attach every
   relevant record to that field/step. Verify each complete quote occurs on its physical PDF page;
   do not mark it verified merely because an opening phrase matches.
3. Nodes: participants, design, `condition` nodes (one per condition), materials, variables,
   analyses, `result` nodes (`result_kind = reported`). Transcribe printed instruments exactly
   as `verbatim` fields; put long instruments in `sources/` and reference them.
   Participant instructions the paper does not print are one rule everywhere: a `missing` field
   (origin `unknown`) with a `decision` issue (`blocking` only when the adapter refuses to run without
   the text; never `check`) whose `suggestedAction` says the researcher supplies the printed text or
   accepts the stand-in wording the adapter uses (labelled as a stand-in until they answer). Like every
   material the paper does not print, it is classified, searched for and asked about as "Materials the
   paper does not print" (below) says.
   Never write your own wording into a `verbatim` or `reported` instructions field.
   **What participants were not told.** Collect every passage saying participants were not told,
   not informed, not shown or unaware of something, had to learn, discover or infer it, or were given a
   cover story. Record them in a `not-told` field on the study's `procedure` node (origin
   `reported`, the passages' evidence), one entry per passage:
   `{"statement": "<the sentence as printed>", "page": 7, "withheld": "which key selects which circle,
   and that only a highlighted circle can be selected", "terms": ["highlighted", "can be selected",
   "yellow"]}`. `terms` are the words a prompt that gave the information away would have to contain,
   short phrases (at most 3 words), at least one of them a content word of the statement (not "told" or
   "participants") and one sharing a word with `withheld`. A passage that is not about what participants
   knew (experimenters blind to condition) gets `"notApplicable": "<why>"` instead; when the sentence
   is about the participants, `notApplicable` also needs a `check` issue on the field so the researcher
   confirms it. The value is `[]` when
   the paper withholds nothing. The adapter's prompts must not contain this information (see section 3).
   Every number the paper reports for a group, item, condition, session or round is a field value,
   not only text inside an evidence quote: see "Result tables" below.
4. Steps: per study, with actors, inputs, outputs, `visibleIds` (who sees what earlier
   responses), `conditionIds` on condition-specific branches and materials, and `next` edges
   only where the paper states order.
5. Issues: one per `missing`/`decision` field or step rule, with exact ids, `reason`, `impact`,
   `suggestedAction`. `blocking` only when the missing rule prevents execution. The app derives
   "Is there enough information to reproduce this study?" from these issues, so be complete and
   honest here rather than optimistic.
6. Optional `extensions.presentation` (`open`, `collapsed`).

### Materials the paper does not print

Papers often describe what participants saw without printing it. Do not let that stop the build, and
never fill it with your own words. As soon as the study map is known (the first checkpoints), list every
participant-facing material each study needs that the paper does not print in full (instruction screens,
items, vignettes, stimuli, trial lists, sequences, orders, practice, feedback, key mappings, display
format) and classify each item on its program field as `extensions.material` (`kind`, `what`,
`mentioned`, and the keys below; format in `check_materials.py`). One field per item: split a gap that
mixes a count and a screen text into two fields, and give a list the paper prints in part one field for
the printed part (`reported`) and one for the rest. Name `what` as the researcher would: "Study 4
instruction screens (both framings)", not "m-s4.instruction-wording".

1. **`schema-enough`**: the study runs faithfully from a structure the paper describes: sequences drawn
   from a printed distribution, the number of trials per condition, a key mapping, a display the paper
   describes completely (two boxes side by side; a highlighted key), and the order of a set the paper
   prints in full (stated as random or counterbalanced, or not stated: then a seeded random order with a
   `decision` issue saying the order is assumed). Fill it from that description: origin `derived` with
   its `derivation` (or `implementation` with `basis`), the passage as evidence, a seeded generator in the
   adapter with the seed recorded in each session. It does not block; a choice the paper leaves open
   within the description (which seed, which side first) is a `decision` issue, not a gap. It is never
   wording: anything participants read or hear, and any picture, photo or recording, is needs-original
   even when the paper summarises it; the value holds structure (numbers, counts, orders, key names),
   not sentences. If filling it would mean writing text participants read, or choosing values the paper
   does not constrain (the actual lotteries of a list it only characterises, a distribution it does not
   name), it is needs-original. When in doubt, it is needs-original.
2. **`needs-original`**: verbatim instrument text or stimuli that cannot be reconstructed: instruction
   screens, questionnaire items, vignettes, word or picture lists, images, audio, a specific stimulus list
   the paper does not print. Never invented. In this order:
   - **Search for public sources before asking.** The researcher may not know the materials are public.
     Look, for this paper only, in: the paper's data and materials availability statement and every link
     or DOI it prints; the journal's supplementary-material page; OSF (search by DOI, title and authors,
     and follow linked and parent projects; list each project's files); the authors' GitHub or GitLab
     repositories; the preprint (PsyArXiv, bioRxiv, arXiv) and its versions; experiment hosting with open
     materials (Pavlovia, Gorilla Open Materials, jsPsych, PsychoPy or lab task repositories); the authors'
     lab pages. Record every search in `sources/SOURCE.json` → `searches` (`{"where", "query", "url",
     "date", "result"}`) and every place looked for an item in its `search` (`{"where", "url", "found"}`),
     so the question lists only what is still missing.
   - **Check before using anything.** It must be tied to this paper (DOI, title or author match, or linked
     from the paper or its OSF project), with the version noted (published SI, preprint v2, repository
     snapshot of a date). Save it under `sources/open/` when the file, its page or the repository states an
     open license (Creative Commons, CC0, an open-source license), otherwise under `sources/private/`
     (usable for this researcher's own project only; say so in the question and the report). Record it with
     `sources.py . --url PATH=URL --linked PATH="linked from p. 9" --source-version PATH="published SI"
     --license PATH=CC-BY-4.0 --license-evidence PATH="OSF project page: License CC-By Attribution 4.0"`
     (its SHA-256 is recorded too). An item copied from `sources/open/` is `verbatim` (`status:
     "found-open"`, cite the file); one from `sources/private/` is a reference to the file like a supplied
     one (`status: "found-private"`, value `{"file": ...}`, never the text in the program).
   - **Never participant data.** Do not download trial-level responses, response or session files or
     demographics, not even to read the sequences or orders participants saw. When those exist only inside
     participant data files, ask the researcher and say so in the question. A file that mixes materials and
     responses is not used. (Human data for comparing results are a separate step the researcher asks for; see
     "Human data" below.)
   - **Ask once, early.** Put every item still missing, from all studies, into ONE question with the
     native `question` tool, right after the inventory and the search, then continue the build. Write it in
     the researcher's language, one numbered line per item (study, what it is, where the paper mentions it,
     what the search found: "the OSF project lists the file but states no license", "only in the
     participant data files"); for something the paper may never have shown ("anything shown at the start
     of session 2"), say "if there was one":

     > The paper does not print some materials participants saw. Do you have them?
     > 1. Study 4: the instruction screens of both framings (the ball-and-bag description), mentioned in the
     >    SI, p. 2, Study 4 procedure. Not in the SI or the OSF project.
     > 2. Study 5: the repeated-choice screens and outcome sequences, SI p. 3. The sequences exist only in the
     >    participant data files, which we do not open.
     > For each one you can upload or paste it (it stays in this project, marked as supplied by you, and is
     > left out of everything HumanStudy publishes: community uploads and exported packages), accept a
     > clearly labelled stand-in written from the paper's description, or leave that part out of the
     > simulation.

     Offer "I will upload or paste them", "Use labelled stand-ins", "Leave them out", and a written answer
     (per item). Set `asked` to the date. A structural item in the list ("how were the decisions ordered?")
     may be answered in words; record that answer as origin `researcher` and the item as schema-enough.
   - **Record the answer per item** (`status`; `asked` and `answer` are required for every answer):
     - `supplied`: save pasted text as `sources/researcher/<item>.txt`; move an uploaded file from
       `sources/` into `sources/researcher/`. The field is origin `researcher`, state `confirmed`, value
       `{"file": "sources/researcher/<item>.txt"}`, and `file` names it. A link the researcher gives
       ("they are on OSF") is a source to download and check as above. The text stays only in that file:
       never copy it into program.json, materials.json, the adapter, views or reports, because those can be
       published; anything derived from it (a mirrored list) is computed by the adapter at run time. The
       adapter reads it (`Path(__file__).resolve().parents[3] / "sources/researcher/..."`) only inside
       `run_sessions` for the arms that need it, and raises a clear error naming the file when it is absent
       (an exported copy has no private materials); `--smoke-test` never needs it. Run `sources.py` (it
       records the folder as `researcher-supplied`).
     - `stand-in`: the researcher accepted a stand-in. Origin `implementation`, the label says "stand-in";
       materials.json and task.json `replayAdaptations` mark it.
     - `left-out`: state `missing`, a `decision` issue titled "Left out by the researcher: <what>", and a
       `capabilities.json` `run.excluded` entry `{"what": "<what>", "field": "<node>.<field>", "reason":
       "left out by the researcher", "arms": [...]}`.
     - no answer, dismissed, or nobody to ask (a batch build): `pending`, state `missing`, no value, an issue
       titled "Needs the original <what>". Make it `blocking` when the arms that need it refuse to run. For
       participant instructions under a `decision` issue (the rule above), the adapter may run meanwhile
       with a stand-in that is labelled as one in materials.json; describe it in `provisional`, and say in
       the issue title that a stand-in runs ("Needs the original Study 1 instruction screens; a labelled
       stand-in runs until then"). The title is what the Simulation tab shows, so it must say exactly what is
       needed. A dismissed question is never an acceptance. Leaving trials out of an arm that runs is a
       `left-out` decision too: never drop part of a study silently.

Run `python .opencode/skills/build/check_materials.py .` until it prints `PASS`: it fails a schema-enough
item that is wording, holds prose no cited quote prints, lacks evidence or blocks; a needs-original item
with invented content, without an issue naming it, answered without `asked`/`answer`, copied from a file
without an open license, or from participant data; a downloaded file without url, license, link to the
paper or version; a missing `searches` record; and private text (from `sources/researcher/` or
`sources/private/`) in program.json or package/. Community and agent exports leave both folders out,
refuse to export while their text is in the program or the package, and leave out any artifact (a
simulation log) that copies it.

### Result tables: every printed table, cell by cell

Transcribe every table the paper prints (results, descriptives, per-item, per-condition, per-session
or per-round values, and sample or stimulus tables) into a table field, so the numbers can be
queried, compared and checked. A quote only locates a table; it does not store it. One field per
table, on the result node it reports (sample tables on `participants`, stimulus tables on `material`):

```json
{"id": "table-2", "label": "Table 2: mean estimates by item", "origin": "verbatim", "state": "confirmed",
 "evidenceIds": ["ev-table-2"], "studyIds": ["study-2"],
 "value": {"table": "Table 2", "title": "the caption as printed", "page": 7,
           "columns": ["Item", "Raters choosing A: M", "Raters choosing B: M", "t"],
           "rows": [["1. First item as printed", "65.7", "48.5", "2.31*"],
                    ["2. Second item", "41.0", null, ".84"]],
           "notes": ["* p < .05 (the footnote as printed)"],
           "uncertain": [{"row": 1, "column": 2, "reason": "smudged in the scan: 3?.4"}]}}
```

- One list per printed row, in printed order; the first cell is the row label; one cell per column.
  Cells are copied as printed, as text: keep `*`, `—`, parentheses, leading-dot decimals and units.
  A printed blank is `""`. Stacked headers are joined with ` / ` (`"Study 1 / M"`). Row groups or
  panels become a column (`"Panel"`) or one field per panel with the same `table` label.
- A cell you cannot read with certainty (scan, garbled text layer) is `null` and listed in
  `uncertain` (0-based `row` and `column`, with what you can see). Never write a plausible value.
  Try the column-aligned text (`--layout`) first, then the page image. A table you cannot read at all is
  a field with `state: "missing"`, value `{"table", "page", "columns": [], "rows": []}` and an issue.
  The reason must be true: before calling a text layer scrambled or unreadable, read the page with
  `--layout`. `check_results.py` fails a missing printed table whose page has clean table rows in its
  column-aligned text. A table the paper only cites (a supplementary table not in the PDF) is not a
  printed table and needs no field.
- Its evidence record locates the table: page and the caption as the quote. Do not paste the
  table into the quote instead of transcribing it.
- Long tables stay complete: save a long table in its own batch; never shorten, sample or summarise it.
- Numbers the text prints per group, item or condition (n, %, M, SD, test statistics) are data
  too: a table field built from the text (origin `reported`, columns named after the paper's
  quantities, `table` omitted and `title` saying it was assembled from the text) when there are
  several groups or items, otherwise one field per quantity (`n-condition-a`, `m-condition-a`, ...).
  The descriptive sentence may stay; the numbers must also be in fields.
- Effects keep pointing to the cells they use: the effect's `resultIds` name the result node,
  its `reported` numbers are the cells, its `reported.evidenceIds` cite an evidence record whose
  quote is the printed row(s) (also listed in the table field's `evidenceIds`), and its `notes`
  name the cells (`table-2: rows 1-2, columns 1-2`).

**Sections the Study document expects** (kind: field ids). State what the paper states; leave the rest out or `missing`.

- 01 Overview: `source` (optional `doi`, `venue`, `version`); `overview`: `year`, `method-type`, `summary`.
- 02 Questions: `background`: `question`, `gap`, `theory`, `concepts`; `hypothesis`: `statement`, `scope`.
- 03 Study map: `studies[]` (`description`, `dependsOn`), `hypothesis.studyIds`.
- 04 Participants: `participants`: `setting`, `roles`, `recruitment`, `eligibility`, `n-recruited`, `n-completed`, `n-analysed`, `characteristics`, `unit-of-analysis` (sampling unit), `compensation`, `attrition`.
- 05 Design: `design`: `type`, `control`, `assignment`, `order`, `blinding`, `manipulation-check`; `condition` nodes.
- 06 Procedure: `procedure`: `task`, `goal`, `actions`, `visible`, `feedback`, `payoff`, `stopping`; `steps`; `material` (verbatim).
- 07 Variables: `variable`: `role` (iv/dv/moderator/mediator/covariate), `type`, `definition`, `scale`, `scoring`, `timing`, `observation-unit` (what one data row is); `record`.
- 08 Analysis: `analysis`: `aim`, `inputs`, `method`, `criterion`, `coding`, `robustness`.
- 09 Results: `result` (`result_kind = reported`): `descriptives`, `effect`, `uncertainty`, `test`, `heterogeneity`, `themes`; one `table-<n>` field per printed table.
- 10 Findings: `finding`: `answer`, `support`, `mechanism-tested`, `mechanism-proposed`, `contribution`, `design-principles`.
- 11 Validity: `limitation`: `validity`, `scope`, `limitations`, `replications`, `openness`.
- 12 Simulation scope: `simulation`: `steps`, `roles`, `conditions`, `outcomes`, `limits`.

Rules: 09 holds what the paper reports (numbers), 10 holds interpretation; never mix them. 12 is your
assessment, so every field has origin `implementation` and must agree with `readiness` and the
blocking issues. 11 `replications` records only replications the paper itself reports or cites;
do no literature search.

Write for a social science researcher: explain the research question, who participated,
what each group saw and did, what was measured, how comparisons were analysed, and what
the findings mean. Use familiar methodological language, not software implementation terms.
Treat these twelve areas as coverage of available information, not twelve boxes to invent
content for. A study without hypotheses or experimental conditions may still be valid.
Preserve all source-supported details in fields or referenced resources; the interface can
collapse detail and the researcher may ask about it later. Distinguish missing extraction,
facts the paper does not report, and features not applicable to its method.

Scope simulation nodes by `studyIds`. All five fields (`steps`, `roles`, `conditions`,
`outcomes`, `limits`) describe what is possible, what is excluded, and why. Include physical,
economic, longitudinal and contextual limitations when relevant. A missing boundary is an
open question, not implicit permission. This assessment is reviewed in a separate screen
before any simulation runs; building the package does not authorize a simulation.

For each evidence record, keep the exact resource path in `path` (including when `sourceId`
is also present), so the interface opens the cited attachment rather than assuming paper.pdf.

Self-check: schema valid; every node, step and paper-derived field has `evidenceIds`; every
evidence id resolves; every `conditionIds` entry names a condition node of the same study; no
placeholder text; interactive and sequential structure intact; all source-supported content preserved.
Write in complete stages and use referenced resources for long materials; never truncate scientific content.

### Self-check (mandatory)

After every write to `program.json` run `python .opencode/skills/build/check_program.py program.json`
and fix every printed problem until it prints `PASS` (between checkpoints, only problems about
records a later batch will add may remain; the final check must print `PASS`). It lists all problems at once, each with a
fix. Typical slips: a step id placed in an issue's `nodeId` (use `stepId`), a `missing`/`decision`
field or rule with no review issue naming its `nodeId`/`fieldId` (or `stepId`), an id in a list
that does not exist. The app tolerates a few slips by setting them aside, but it warns the
researcher; a clean check is the standard.

Before reporting completion run `python .opencode/skills/build/check_program.py program.json --complete`.
Run `python .opencode/skills/build/check_results.py program.json` and fix what it prints until it
prints `PASS`: a table field that is malformed, a result node whose numbers are only inside evidence
quotes, a quote that reads like a table nobody transcribed, and a printed table caption (`Table 2`)
with no table field of that label. Fix by transcribing, never by deleting the quote or the evidence.
Run `python .opencode/skills/build/sources.py . --check` too; it must print `PASS`.
Run `python .opencode/skills/build/check_verbatim.py program.json` until it prints `PASS`: every field
labelled `verbatim` must hold the printed words of its cited page, word for word (`40` for a printed
"Forty" is not verbatim). For each problem, reread the page and either copy the exact printed words
(and cite the page they are on) or, when the field is a description, summary or paraphrase (a
stimulus-generation description, a hypothesis restated, a sample size written as a number), relabel
it `reported` (or `derived` with its `derivation`). Never invent or pad text to make it match. When
the page image shows your text is right and the text layer misreads it (OCR noise such as "dram" for
"drain"), keep the printed words and set the cited evidence's `verification` to `unverified`. Fields it
reports as unchecked (scanned pages) you compare with the page image yourself.
Then run `python .opencode/skills/build/check_quotes.py program.json`: it compares every evidence
quote with the text of its cited page. Fix `other_page` (wrong page number) and `not_found` (wrong or
reconstructed quote) by rereading the page; if the page is a garbled table or scan, set the evidence
`verification` to `unverified` and say so in the report. Never mark a quote `verified` that this check
cannot find.
For every identified empirical study account for participants, design, procedure, variables/records,
analysis and results. For an analysis-only scope account for analysis and results. These are coverage
checks, not a fixed experimental template: information the paper omits is an explicit `missing` field
with its targeted issue, not invented content. Shared nodes may supply shared details, but every
study needs its own scoped content or explicit missing information. A valid checkpoint is not a
completed paper. Recheck after any change; PASS applies only to the checked bytes.

Always use `program_io.py` for agent edits, including refinements; do not bypass its lock/protection
with direct writes to program.json. Confirmed researcher fields are kept when a batch conflicts;
the complete proposal is saved under `.humanstudy/program-conflicts/` with a review issue. Discuss it
with the researcher, who can accept it by editing that field. Never relabel the saved human edit.

Finish and validate the visible program **before** packaging or views. Do not delay the
program until these auxiliary artifacts exist.

## 3. Package: make the study runnable

Unless the researcher only asked for the program, continue and write `package/<paper-slug>/`
with exactly these six core files (additional participant materials are allowed, no other
sidecars). `program.json` stays the single source: the package refers to it and never copies it.

```text
study.json                     overview; programRef: {"path": "../../program.json", "id": <program id>};
                               readiness: {status: ready|blocked, blocking: [...issue ids]}
                               (no copy of the program)
source/paper_metadata.json     bibliography + external_sources (empty if none authorized)
materials/materials.json       participant-visible material by study and condition, verbatim
task/task.json                 agents, roles, order, visibility, scripted roles + justification,
                               conditions, sampling/assignment/observation units, programBindings
task/adapter.py                offline; --smoke-test; run_sessions(llm, seed, n, arms=None)
evaluation/evaluation.py       evaluate(sessions) -> dict; not_ready when a test cannot run
```

Do not write `source/evidence.json` or `audit/missing_information.json`: the evidence and the
missing information are `program.json`'s `evidence` and `issues`, and every tool reads them there.
(Older packages that still hold a program copy and those two files keep working.)

Rules the runner depends on:

- `task/task.json.programBindings` = `{programId, stepIds, recordNodeIds, analysisNodeIds}`,
  exactly the program's id, every step id in order, every `record`/`variable` node id, every
  `analysis` node id.
- `run_sessions(llm, seed, n, arms=None)`: `llm(prompt) -> str` is injected; call it for every
  original human participant (never a script, distribution or fixed answer for a role the paper
  did not script). `n` is the sampling unit stated in `task.json`. `arms=None` runs every arm the
  paper's comparisons need; each session dict carries `condition` and `arm`. The adapter builds
  its own prompts from `materials/materials.json`, parses replies into the response format the
  paper used, and needs nothing from the researcher at run time.
  Keep the prompt for one participant and the reply parser as module-level functions (for example
  `build_prompt(study, condition)` and `parse_reply(study, condition, reply)`), so a simulation can run
  an exact number of AI participants per condition in parallel (`simulate` skill).
- `evaluate(sessions)` derives every metric from `sessions` alone and returns the paper's own
  comparison (test, statistic, effect size) or a structured `not_ready` with what is missing.
- **Validity of the replay** (the package exists to replay what participants experienced):
  - Prompts never tell participants what the paper says they were not told or had to discover (the
    `not-told` field). No legend, key map, rule or hint written by you; only text the paper prints as
    participant material, at the point the paper shows it (a debriefing after session 3 appears
    from session 4 on).
  - Memory between trials: by default a prompt carries what a participant plausibly saw at that
    moment (the current screen, the last outcome, a counter shown on screen), not a labelled log of
    every earlier trial; a full log leaks task structure, inflates carry-over and stability effects
    and makes cost grow with the square of the trial count. Record the design as a `replay-memory`
    field on the procedure node (origin `implementation`, state `decision`, value
    `{"design": "none | last-trial | summary | same-screen | full-log | conversation | other", "shows":
    "...", "participantsSaw": "...", "expectedImpact": "..."}`) with a `decision` issue stating the
    expected impact. A full log or chat transcript (or `other` over prompts that carry every trial)
    needs a cited quote saying participants saw their earlier choices or outcomes ("their previous
    choices were displayed"), or a researcher's decision. A questionnaire whose items share one page is
    `same-screen` (earlier items stay visible), with the quote that says they were on one page or
    shown together; do not choose `none` there and break the sequential visibility of the form.
  - Instructions between blocks, sessions or phases appear in the first prompt of the new block when
    the paper shows them there ("the upcoming block is completely independent", a break of one week),
    never only inside a later trial log. No script checks this (the captured prompts carry no block
    boundary to compare with the paper), so check it yourself on the first prompt of every block and
    say in the report where each between-block instruction is delivered.
  - An unparsed reply is recorded on its trial (`"parsed": false`), the participant is kept, and
    trials or participants are excluded only by the paper's own rule. Never `valid = all(...)` over the
    trials' parse status; a line that applies the paper's printed exclusion rule carries
    `# exclusion: <evidence id>` on the line above, citing the quote that states which participants,
    trials or responses were excluded.
- Run `python .opencode/skills/build/check_program.py program.json` (it also runs inside check_package.py), then `python .opencode/skills/build/check_package.py package/<paper-slug>` (required files,
  JSON validity, bindings, `sources/SOURCE.json`, smoke test, and `check_validity.py`) and repair until it
  passes. `check_validity.py .` runs the adapter offline with a stand-in model (all arms, then each arm
  study.json or task.json names; an adapter that does not finish fails), reads every prompt and
  fails on a `not-told` term in text you wrote, a passage of the paper about withheld information
  that no `not-told` entry lists, a trial history with no `replay-memory` decision (or a design that
  does not match the prompts), `all(...)` over the trials' parse status, and missing instructions with
  severity `check` (or `blocking` while the adapter runs) or without a `decision` issue. Fix the prompt, never the inventory: removing a term or an entry to pass is a fabrication. The
  smoke test and every export run the package in the project layout, so `task/adapter.py` may read
  `../../program.json` (and `effects.json`, `capabilities.json`, `sources/` beside it), nothing else outside the package.
- The desktop app shows a package as ready to simulate only when all of these pass on its own copy of
  the checks (`check_readiness.py`): `check_program.py --complete`, `sources.py --check`,
  `check_package.py`, `check_validity.py`, `check_verbatim.py`, `check_results.py`, `effects.py` and
  `check_materials.py`.
  Each failing check shows its first problem in the Simulation tab. Editing the checkers inside the
  project changes nothing there: fix the program, the package or effects.json.

### Effects: from hypotheses to computable effects

`effects.json` (beside `program.json`, schema `schema/effects.schema.json`) is the executable link
from the paper's hypotheses to its data. Write it after the package check passes. It adds no study
facts: every number in it is written in a quote of the program's `evidence`.

```json
{"schemaVersion": 2, "programId": "<program id>",
 "topics": ["keywords for the paper, as the field names them"],
 "hypotheses": [{"id": "h1", "nodeId": "<hypothesis node>", "status": "tested",
                 "backgroundIds": ["<background node>"], "phenomena": ["framing effect"]}],
 "effects": [{
   "id": "loss_frame_risky", "label": "Loss vs gain frame: share choosing the risky option",
   "role": "test", "hypothesisIds": ["h1"], "studyId": "<study id>",
   "design": "between", "unit": "participant",
   "outcome": {"variableId": "<variable node>", "type": "binary", "scale": "risky / sure",
               "higherMeans": "more risky choices"},
   "contrast": {"kind": "two_groups", "treatment": "loss", "reference": "gain",
                "conditionIds": ["<condition node>", "<condition node>"], "factorIds": ["<IV variable node>"],
                "valueMeans": "loss minus gain"},
   "prediction": {"direction": "positive", "evidenceIds": ["<evidence>"]},
   "analysisIds": ["<analysis node>"], "resultIds": ["<result node>"],
   "compute": {"op": "proportion_difference", "field": "responses.choice", "success": ["risky"]},
   "reported": {"estimates": [{"metric": "risk_difference", "value": 0.44, "variant": "as printed",
                               "evidenceIds": ["<evidence>"]}],
                "cells": {"loss": {"n": 155, "percent": 72}, "gain": {"n": 152, "percent": 28}},
                "test": {"statistic": "chi_square", "df": 1, "p": 0.001, "pRelation": "<"},
                "missing": ["what the paper does not report"], "evidenceIds": ["<evidence>"]}}]}
```

Rules:

- Every `hypothesis` node of the program appears once in `hypotheses`: `tested` (at least one effect
  names it) or `untested` with `untestedBecause` (`not-an-effect`, `not-tested-in-paper`,
  `not-computable`, `out-of-scope`) and a `reason`. When the paper states no hypothesis but tests
  effects, add the hypothesis node to the program first (from its aims or predictions, with evidence).
- One effect per comparison the paper reports for a hypothesis (per outcome, per contrast, per study).
  `role`: `test` (it tests a hypothesis), `robustness` (the same test another way), `check`
  (manipulation, attention, recall or balance check), `descriptive`.
- The value is always **treatment minus reference** in the outcome's own units. Name them as the
  sessions do (`condition` values). Do not flip signs: `prediction.direction` says which sign the
  hypothesis expects.
- `reported` holds raw quantities exactly as printed: estimates (with `metric` from the schema's list
  and `variant` naming the model or weighting), the test, cell n / mean / sd / k / proportion or
  percent, as printed (a paper printing 72% gives `"percent": 72`, not 0.72).
  Each number must be written in a quote of one of `reported.evidenceIds`; when the program's quotes
  do not hold a number, add an evidence entry with the verbatim table row or sentence and its page
  (`program_io.py`, then `check_quotes.py`). List what the paper does not report in `missing`; never
  compute it or fill it in. `reported` is `null` when the paper prints no number for the effect.
  Order `estimates` so the first one is the variant the package computes (for example unweighted).
- `reported.n` (or `cells.<arm>.n`) is the N the effect is computed on, as printed, with the quote that
  prints it among `reported.evidenceIds`. When the effect's N is not printed (a subgroup, trials as
  the unit) say so in `missing` ("N of the LAC-first group is not printed"); never fill in the study N
  for a subgroup.
- Signs: a difference (d, dz, g, mean or risk difference, log odds ratio) is treatment minus reference.
  Papers often print it unsigned; take the sign from the printed cells or the sentence saying which
  arm was higher, and store it signed (−0.32 when the treatment arm is lower). Without cells, add
  `signBasis` to the estimate with those printed words. A sign you change changes the CI too
  ([lo, hi] becomes [−hi, −lo]); the CI must contain the value. Never choose a sign to agree with the
  prediction: a result against the prediction is stored against it.
- `compute`: prefer a built-in op when each session holds the participant's value:
  `mean_difference` (Welch t), `paired_difference` (`field` minus `referenceField` within a session),
  `proportion_difference` (`success` values), `contingency` (chi-square, phi / Cramér's V over
  `groups` x `levels`), `correlation` (`field` with `withField`). Use `where` for exclusions that are a
  session flag (`{"valid": true}`) and `study` when the session's `study` differs from `studyId`.
  Otherwise use `{"op": "package", "key": "<id>"}` and add to `evaluation/evaluation.py`
  `effect_estimates(evaluation) -> {key: block}` returning, from the evaluation it already computed,
  the block `{"status": "computed", "metric", "value", "se", "n", "cells", "test", "method"}` (or
  `{"status": "not_ready", "reason"}`). Keep cells raw (n, mean, sd, or counts).
- `compute.compareAs` only when the computed and reported numbers are the same quantity under
  another name, with the reason (an OLS coefficient on one condition dummy is the mean difference).
- `population` says whose responses the reported numbers describe: omit it for human participants;
  a paper that itself tests AI models records each model's result as an effect with
  `{"kind": "ai-model", "models": ["gpt-4o"]}` (or `human-vs-ai-model`, `ai-model-vs-ai-model`), so a
  human-only analysis can leave them out.
- An effect may list its own `phenomena` when its hypothesis spans several (a yes-no bias effect under
  a hypothesis about yes-no and omission bias); otherwise it inherits the hypothesis's.
- `phenomena` and `topics` are plain keywords in the paper's own wording (as it names its effect or
  construct); do not normalise, translate or merge them with other papers' terms, and do not invent codes.

The paper is one typed graph (`study_core.py graph`): program nodes and steps, effects, and the
constructs named by `phenomena`/`topics`, joined by the core edge types in `schema/graph-types.json`.
Schema 2 rules:

- Never write `other` for `contrast.kind` or a metric. Use the core terms: besides `two_groups`,
  `paired`, `single_group`, `association`, `interaction` and `omnibus` there are `linear` (weights
  per named cell plus an optional `constant`, e.g. `{"simple": 1, "complex": -0.5, "ambiguous": -0.5}`),
  `ratio` (treatment / reference) and `model_comparison` (evidence for one model over another);
  metrics include `cohens_q`, `auc`, `ratio` and `percent_change`.
- If nothing fits, do not force it in. Either declare an extension in `extensions`
  (`{"name": "x:...", "category": "contrast" | "metric" | "edge" | "node", "parent": "<core term>",
  "definition": "..."}`; tools that do not know it read it as its parent), or list the hypothesis as
  `untested` with `untestedBecause: "out-of-scope"` and say what kind of claim it is. Extensions that
  several papers need are promoted into the core later; files are never rewritten for it.
- `links` adds edges the effects do not state, between any two nodes (program node or step ids,
  `effect:<id>`, `construct:<label>`, `paper:<programId>/effect:<id>` for another paper):
  `{"from", "to", "type", "origin": "verbatim" | "reported" | "derived", "evidenceIds"}`, e.g. a
  variable that `mediates` an effect, a condition that `manipulates` a construct, an effect that
  `replicates` another paper's. Each type has fixed from/to node kinds; the check enforces them.

A built-in op must read fields that both the human loader's sessions and the adapter's sessions
carry (the same path in both; `trials.0.answer` indexes a list); the check runs the adapter with a
stand-in model to make sure. Run `python .opencode/skills/build/effects.py .` until it prints `PASS`; it
also fails an effect whose quotes or study print N while `reported.n` is empty and `missing` says
nothing about it, a `reported.n` its quotes do not account for (printed, a printed total minus a printed exclusion
count, a printed per-group N times the arms, the sum of the cells, or df + 1 / df + 2 of a printed test),
a signed estimate whose sign disagrees with its own cells, a CI that does not contain its value, and
an unsigned printed estimate without cells or `signBasis`. Its warnings list program
nodes no hypothesis or effect reaches; link them where the paper links them. With human data, run
`study_core.py reproduce` (it uses `effects.json`) through the launcher, as in section 3's human
data step, and report the verdict per effect.

### Capabilities and failure cases

Every tool checks `capabilities.json` before doing work and refuses what it says the study cannot
do. After the package check passes:

1. If part of the paper cannot be run as published, first record it in `capabilities.json` →
   `run.excluded` (create the file with `{"schemaVersion": 1, "run": {"excluded": [...]}}` if it does
   not exist): one entry per part, `{"what": "...", "reason": "...", "arms": [...]}`, with `arms`
   the package arm names it covers. Typical parts: picture or audio stimuli, reaction times, eye
   tracking or physiology, materials the paper does not print, participants that are not people.
   Never run a proxy for an excluded part.
2. Run `python .opencode/skills/build/capabilities.py .` It derives everything else from the files
   (program check, readiness, human-data check, author-code key, reproduction) and keeps your
   `run.excluded`. Do not edit the derived fields by hand.
3. Write `artifacts/failures.json`: a list with one entry per place where the template does not fit
   this paper, `{"pattern", "where", "what", "fallback", "suggestion"}`. `pattern` is one of
   `non-text-stimuli`, `materials-not-public`, `missing-information`, `interaction`,
   `sequential-dependence`, `modelling`, `non-human-participants`, `unsimulable-measure`,
   `author-code-unusable`, `author-code-not-reproducing`, `human-data-incomplete`, `other`.
   State only what the program, the package or the paper shows; `[]` when nothing applies.
4. `python .opencode/skills/build/capabilities.py . --check` must print `PASS`.

### Human data (when the researcher provides or points to them)

Human data never go into the package or any repository; the package carries a key instead.
With the original data files in `human-data/` and a loader `package/<slug>/human/human_sessions.py`
(`load(data_dir)`, `key_effects(evaluation)`, `SOURCE`, `EXCLUSIONS`, `NOT_MAPPED`), write
`package/<slug>/human/key.json`:

```json
{"schemaVersion": 1, "loader": "human_sessions.py",
 "sample": "original | replication | other", "sampleEvidence": "why, in one sentence",
 "repository": {"url": "landing page", "title": "...", "license": "CC0 | CC-BY-4.0 | null", "licenseEvidence": "where it says so"},
 "pinnedAt": "YYYY-MM-DD",
 "files": [{"path": "relative to human-data/", "sha256": "...", "bytes": 0, "role": "data | documentation",
            "url": "direct download URL serving exactly these bytes, or null",
            "archiveMember": "path inside the zip at url, when the file is only published inside one",
            "note": "anything a user needs, e.g. where an unavailable file can be obtained"}]}
```

Give a `url` only after downloading it and seeing the same SHA-256. Then fetch the pinned files with
`python .opencode/skills/export/agent/study_core.py --root . human-data` (no package code runs) and
run the analysis with
`python .opencode/skills/simulate/run_confined.py --no-model .opencode/skills/export/agent/study_core.py --root . reproduce`
and report its verdict. The launcher runs package code without network or model access on macOS
and as before on Linux and Windows.

## 4. Views: two artifacts, automatically

After the program check prints `PASS` (and the package check, if you built the package), write
two views with the `visualize` skill's kit, without being asked; each must pass
`python .opencode/artifact-kit/inline.py <file>`:

- `artifacts/study-overview.html`: a title naming the paper, a two-sentence takeaway (what was
  studied, who took part, the design), then `HS.overview('#app')` (sample sizes, procedure flow,
  conditions, open questions per study).
- `artifacts/reported-results.html`, only when `09 Results` holds reported numbers (means,
  percentages, proportions, effect sizes): one `HS.results` or `HS.forest` chart per comparison the
  paper reports, using the paper's numbers exactly, each mark with its `id` and `page` (the table
  or text it comes from); spread exactly as reported (SD, SE or CI) or left out so the kit marks it
  "spread not reported". Test statistics without descriptives (only F, t, p) go in the chart's
  `hs-sub` line or a cited stat tile, not invented bars. Skip this file when no numbers are
  reported, and say so in the report.

A view failing its check is fixed, not dropped. Do not add new study facts in a view.

## 5. Report

Reply with: studies found; counts of nodes, steps, conditions, issues (by severity); tables
transcribed and cells left uncertain; materials the paper does not print (schema-enough filled,
needs-original found open, supplied, stand-in, left out, still needed, by name); the
readiness verdict ("can be run as published" / "blocked by: " and what exactly is needed); what capabilities.json says
cannot be run and why; checks run and their result;
and the paths written (including the two views). Reply in the researcher's language.

## Clarifying decisions with the researcher

When missing information or conflicting sources require a researcher decision, use the native
`question` tool with a few clear alternatives and allow a written answer. Ask only the next
necessary question in the currently selected study; do not force the same wizard on every
experiment. The one exception is the materials question ("Materials the paper does not print"): one
question for every missing material of the paper, asked once. Retain the source evidence and label actual user choices `researcher`; never
convert a suggested default or dismissed question into a confirmed study fact.

### Text-layer numeric sign loss

Keep the extracted quote unchanged. If a PDF text layer loses an exponent minus (for example `1.9e 11`) or separates a printed minus (`− 0.011`), inspect the rendered page before recording the number. On that same evidence record, set the physical `locator.page` and `note: "rendered page checked"`. Only use this note after visual verification; otherwise leave the value missing. The effects validator reports this exception explicitly. An explicit positive exponent is never treated as a lost minus.
