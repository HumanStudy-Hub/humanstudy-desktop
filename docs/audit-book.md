# Pipeline audit book (draft)

A rubric for finding problems in the paper → program → package → agent pipeline **before** they reach users,
and for turning every bug we fix into a check that keeps it fixed. People and agents use the same book.

## How it relates to the evaluation

The pipeline evaluation measures how well the pipeline does against expert-curated ground truth. The audit
book covers what the evaluation cannot.

**The evaluation:**

| | Stages | Question | Compared with |
|---|---|---|---|
| EVAL 1 | 1–2 | Is the extracted information correct? | HumanStudy-Bench annotations, Many Labs protocols |
| EVAL 2 | 3 | Is the procedure correct? | Replay against Psych-101 trial data and published LLM replications |
| EVAL 3 | 4 | Do the generated tools help a researcher agent? | Recent OSF studies newer than the models |

**What the audit book covers instead:**
- **Studies without ground truth.** Most bulk-extracted studies have none.
- **Problems a score hides.** Examples: an invented stimulus that happens to match; a run whose participants shared one context.
- **Everything after extraction.** Publishing, the catalog, exports, the desktop and web surfaces, and the release process.

Where an audit item has a quantitative counterpart, the item names it (for example, "→ EVAL 1"). The
quantitative eval says *how much*; the audit says *what is wrong and where*.

## How to run an audit

**When:**
- Every build: the builder runs the `auto` checks.
- Every published study and every batch: an auditor runs the `auto` and `agent` checks on a sample. For bulk extraction, start with at least 1 in 5 studies plus every study with a `partial` or `blocked` capability.
- Every release: the `release` section.

**Who:**
- `auto` checks are scripts.
- `agent` checks are done by a **fresh agent that did not build the study**. It gets the paper, the package and this book, and nothing from the build conversation.
- `human` checks need a researcher.
- The builder's own "done" never counts as an audit.

**Output.** One `audit.json` per study or batch:

```json
{"book": "audit-book/0.1", "target": "paper_28d927cc…/revisions/fabc19…", "auditor": "agent:fresh",
 "items": [{"id": "X3", "result": "concern", "evidence": "program.json#node:exp3.items; paper p. 14",
            "note": "Big Five inventory not named"}]}
```

**Results:**
- `pass`
- `concern`: possibly wrong, needs a look.
- `fail`: wrong.
- `n/a`: does not apply.

Every result other than `pass` or `n/a` needs evidence: a file and field, plus a page or quote. A `fail` blocks publishing that study, or that capability.

**Severity:**
- **S1** gives users wrong research content: an invented material, a wrong number, participants who were not independent.
- **S2** hides or misstates what the study can do, or breaks a surface.
- **S3** is quality or cost.

## The loop: every bug becomes an item

When a bug is found anywhere (a tester report, a review, a failed run), add an incident to the log at the end
of this book:

1. **Symptom:** what someone saw.
2. **Root cause:** what was actually wrong.
3. **Missed by:** which audit item should have caught it, or "none".
4. **Fix:** the change, with its PR.
5. **Guard:** the item added or sharpened. Where possible, also an `auto` check or test, so it cannot silently return.

An item that keeps finding the same problem by hand should become an `auto` check. An item that never finds
anything over several batches should be reviewed: either the problem is gone, or the item is too vague to catch it.

---

## S — Source intake

| ID | Check | How | Sev | Notes |
|---|---|---|---|---|
| S1 | The paper is the right paper and version: DOI resolves to the same title; preprint and published versions are not confused | auto | S2 | Incident I-01 |
| S2 | The source files used are hashed and the hashes recorded (PDF, supplements, data) | auto | S2 | Bench#34 |
| S3 | License of PDF, materials, data and author code is recorded, or recorded as unknown | auto + human | S2 | Bench#34 |
| S4 | All supplements, appendices and OSF materials the paper points to were looked for, and the result is recorded (found / not public / not found) | agent | S2 | |
| S5 | Scanned or image-only pages were OCR'd or read as images, not skipped | auto | S1 | Desktop PR #42 |
| S6 | Every study in the paper is found, including pilots and studies reported only in the supplement | agent → EVAL 1 | S1 | Desktop PR #42 (missed-study check) |

## X — Extraction fidelity (program.json)

| ID | Check | How | Sev | Notes |
|---|---|---|---|---|
| X1 | Every `verbatim` field appears word for word in the source at the cited page | auto | S1 | Quote check (`check_quotes.py`) |
| X2 | Nothing paraphrased is labelled `verbatim`; nothing quoted is labelled `derived` | agent | S1 | |
| X3 | Gaps are labelled `missing`, never filled with plausible text. The auditor picks the 5 fields most likely to be guessed (exact wording, response scales, counterbalancing, stimuli lists) and checks each against the source | agent | S1 | Core contract, `agent_pipeline/CLAUDE.md` |
| X4 | Sample sizes (recruited, excluded, analysed), conditions and assignment match the paper | auto (where Bench GT exists) + agent → EVAL 1 | S1 | |
| X5 | Reported statistics are exact: numbers, signs, inequality direction (p < .001 vs p > .001), df | auto + agent → EVAL 1 | S1 | Fixed in 0.6.7 for source lookup |
| X6 | Each open issue is real (the paper does not state it) and specific; no filler issues | agent | S3 | |
| X7 | Evidence pages are right: a sample of 10 quotes is found on the cited page | auto | S2 | |
| X8 | Every study and condition in the paper appears in the program, or is listed as excluded with a reason | agent → EVAL 1 | S1 | |
| X9 | Commercial or copyrighted instruments are marked location-only; their items are not included | auto + agent | S2 | Bench#34 |

## P — Procedure and participants (package)

| ID | Check | How | Sev | Notes |
|---|---|---|---|---|
| P1 | **Participant independence:** each AI participant answers in a fresh context, with no access to study files, hypotheses or other participants' answers | auto | S1 | Incident I-02 |
| P2 | Sequential visibility: a participant sees each screen only when the original participants did; nothing later leaks into an earlier prompt | agent → EVAL 2 | S1 | Core contract |
| P3 | Prompts contain no hypothesis, condition names or study labels that the original participants did not see | auto + agent | S1 | |
| P4 | Every original human subject role is an agent participant; scripted partners are used only where the paper used them, and are labelled | agent | S1 | Core contract |
| P5 | Conditions are assigned as in the paper (random, counterbalanced, blocked); counts per arm are balanced as designed | auto | S2 | |
| P6 | Replies are parsed into the paper's response format; unparseable replies are counted and reported, never dropped silently | auto | S2 | |
| P7 | Studies that cannot run (missing materials, unsupported modality) refuse to run; nothing is substituted | auto | S1 | Burton 2022, Kreis 2025 |
| P8 | Profiles, if used, are recorded per session and the run is labelled as a deviation | auto | S2 | Desktop #45 |

## A — Analysis and human data

| ID | Check | How | Sev | Notes |
|---|---|---|---|---|
| A1 | The analysis reproduces the paper's reported statistics from the original human data, within the stated tolerance | auto → EVAL 1/2 | S1 | `reproduce_paper`, desktop #45 |
| A2 | Exclusion rules are applied as in the paper, and the counts match | auto + agent | S1 | |
| A3 | Effect definitions and directions match the paper (which group minus which) | agent | S1 | |
| A4 | Author code is never edited to make numbers match; differences are reported | human | S1 | |
| A5 | The parts of the design missing from the human data are listed (`notMapped`) and not compared | auto | S2 | Thomas Exp. 2–3, 14 Many Labs 2 effects |
| A6 | Human data are not in any repository; the key (source, version, hash, license) is recorded | auto | S1 | Standing rule |
| A7 | AI vs human comparisons report n, the uncertainty and the direction match, not only a pass/fail | auto | S3 | |

## T — Tools and agent export

| ID | Check | How | Sev | Notes |
|---|---|---|---|---|
| T1 | Export self-test passes (files and hashes, every study renders, scripts run, MCP tools respond, replay smoke test) | auto | S2 | `agent_package.py` |
| T2 | No local paths, user names, keys or private project files in any export or published file | auto | S1 | Checked by hand for the first 12 skills |
| T3 | No duplicated content inside a published revision | auto | S3 | Incident I-05 |
| T4 | Tools refuse what `capabilities` declares impossible; no substitute output | auto | S1 | Desktop #45 |
| T5 | Install lines in README work on macOS and Windows (`python3` vs `py`) | auto (CI) | S3 | |
| T6 | The skill answers 5 standard questions correctly from the files alone: what was the design, what did a participant see in condition X, what was the main result, what is missing, can it run | agent → EVAL 3 | S2 | |

## C — Publishing and catalog

| ID | Check | How | Sev | Notes |
|---|---|---|---|---|
| C1 | Catalog entry has title, authors, year, DOI and a description | auto | S2 | Incident I-04 |
| C2 | One paper, one entry: no duplicates across DOI, preprint DOI and title keys | auto | S2 | Incident I-01 |
| C3 | Published files follow the sources policy: no PDFs, `sources/` or human data unless the license allows | auto | S1 | Bench#34; incident I-06 |
| C4 | Capabilities are honest: `traceable` only after a human line check, `replayable` only with a passing replay | auto + human | S1 | |
| C5 | Revision manifest hashes match the files; the previous revision is kept | auto | S2 | `catalog.py` |
| C6 | The website database, the GitHub snapshot and the desktop library show the same revision after a sync (allow for the 30 s search cache) | auto | S2 | |
| C7 | A paper with missing optional fields (no authors, no resources) still renders on web and desktop | auto | S2 | Incident I-03 |

## U — Product surfaces

| ID | Check | How | Sev | Notes |
|---|---|---|---|---|
| U1 | The library lists only extracted studies; not-yet-extracted papers are in their own view | auto | S2 | Incident I-07 |
| U2 | Opening a study gives a project with content (program, materials, artifacts); never an empty project | auto | S2 | Incident I-07 |
| U3 | Library and study pages refresh after a publish without restarting the app | auto | S3 | Incident I-08 |
| U4 | Each study shows what it can and cannot do, in words a researcher understands | human | S2 | |

## R — Runs, cost and release process

| ID | Check | How | Sev | Notes |
|---|---|---|---|---|
| R1 | "Done" is checked against files, not against the model going idle; a schema pass is not taken as completeness | auto | S1 | Paper2Agent research findings |
| R2 | Request size stays under the gateway limits; failures name the cause (size vs context) | auto | S2 | `docs/request-transport.md` |
| R3 | Cost per study is recorded; batch runs stop before the hosted quota is exhausted | auto | S3 | Incident I-09 |
| R4 | Release: version bumped after all intended PRs are merged and not drafts; tag only on the merged commit; all 15 release files present; Mac app notarized; update feeds show the new version | auto (checklist) | S2 | Incident I-10 |
| R5 | No secrets in logs, issues, PRs or published files | auto | S1 | |

---

## Incident log

Seeded from incidents fixed in October 2026. New incidents are appended; IDs are never reused.

| ID | Symptom | Root cause | Missed by | Fix | Guard |
|---|---|---|---|---|---|
| I-01 | Pennycook 2020 could not link to its catalog entry | Catalog held the preprint DOI; the package used the published DOI | none | Published as a separate entry | S1, C2 |
| I-02 | In an early pilot, one context answered every gain-frame prompt the same way | Many participants answered inside one conversation | none | Fresh process per participant (`run --cli`) | P1 |
| I-03 | Study detail pages returned 500 | Catalog entries without `authors`/`resources` crashed the page | none | Web PR #33 | C7 |
| I-04 | Published papers showed "No description" | Publishing never filled `description`; the package overview was ignored | none | Bench PR #31 | C1 |
| I-05 | Agent skill listed `program.json` and `package/` twice (35 files) | Export copies them into the skill; the revision already had them | none | Bench PR #33 | T3 |
| I-06 | 17 publisher PDFs in public `studies/` | Two publishing rules (legacy vs community) | none | Open, Bench#34 | C3 |
| I-07 | Opening most library papers gave an empty project | Library listed all 309 indexed papers; 282 had no assets | none | Web PR #34, desktop PR #44 (0.6.8) | U1, U2 |
| I-08 | New files not visible in the desktop app after publishing | The Studies list loads once per visit and is not refreshed while open | none | Open | U3 |
| I-09 | Formal extraction stopped mid-batch | Hosted key quota exhausted ($100 of $100) | none | Open | R3 |
| I-10 | A 0.6.9 tag was pushed before the feature PR merged | The PR was still a draft; the merge failed silently in a chained command | none | Tag deleted, run cancelled, re-tagged after merge | R4 |

## Open questions for the next version of this book

- Sampling rate per batch once bulk extraction starts.
- Which `agent` checks are reliable enough to block publishing, and which only raise concerns.
- A machine-readable copy (`audit-book.json`) so auditor agents get one item at a time with its evidence requirements.
- Whether the auditor should see the builder's open issues (risk: anchoring) or only the paper and the package.
