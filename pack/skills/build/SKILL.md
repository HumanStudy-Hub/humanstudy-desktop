---
name: build
description: Build a complete source-linked Human Program and prepare requested experiment scopes from a human-study paper. New projects use the protocol engine; preserve missing materials and never simulate without approval.
---

# Build: paper to protocol

Follow AGENTS.md and the shared [protocol authoring reference](AUTHORING.md). Importing a paper authorizes
its first build. Simulation requires separate approval.
A new study's deliverable is a complete **program.json** (Human Program v2, scholarly-v1 profile; read
[SCHOLARLY.md](SCHOLARLY.md)), a **protocol.json** experiment map, source evidence in **sourcetext/**,
a study card **study.json**, and a current offline **artifacts/preview.html**. Program describes the research;
protocol is the only executable definition. Do not create a duplicate execution graph or Python package.
For a new paired draft set `protocol.meta.delivery` to `research-program-v1`; the app checks the pair and view.
First make the complete research document readable across all studies. Do not spend many rounds building
all experiments before the user asks to run one. A not-yet-prepared scope remains explicitly non-runnable,
with that reason distinguished from unavailable source material. Previously prepared scopes remain intact. Existing legacy projects stay unchanged unless migration
is explicitly requested; their old procedure is in LEGACY.md. Never relabel an old program as a protocol.

## 1. Read the sources

Keep shell calls at the project root and use project-relative paths without `..` segments. For example, use
`head -80 .opencode/skills/build/program_io.py` without changing directories. Use the
bundled schemas and native read/search tools. Use the native write tool to save long JSON
patches and scripts, then run the checkpoint writer or script in a separate shell call.
Omit shell no-ops and redirects to paths
outside the project, including /dev/null. Pass the checkpoint writer's printed hash literally
in the next call. If a path is denied, leave it alone and retry
with a project-relative path.

Read paper.pdf in physical page ranges with `hs-pdf pages paper.pdf --from N --to M`. Save the exact extracted
text, retaining page boundaries, as sourcetext/paper.txt. Read relevant authorized supplements similarly.
Inspect page images for tables the text layer loses. Never guess unreadable text, signs, labels or cells.
Use the paper's main results to guide the research overview, including findings outside the runnable scope.
Save a valid scholarly checkpoint as soon as the studies are identified. Use targeted schema reads
instead of reading the full protocol schema before the first save. Follow SCHOLARLY.md's evidence
check before reporting completion.
Build and check the initial delivery from the paper and materials already in the project. Record
missing materials and the exact source needed. Search for external materials when preparing a
requested experiment, under AGENTS.md's rules. Do not fetch participant-level data.

## 2. Prepare the requested experiment

When the user says they want to run an experiment, prepare that scope using the existing source map and
research document, preserving the others and all researcher edits. Do not repeat a completed whole-paper
extraction. Start with the paper's material links. For OSF, list files with
`python .opencode/skills/build/fetch_source.py . --list <OSF URL>`, then use that helper to
save the relevant instruments and stimuli with their provenance. Check which parts of the
requested flow those files support, including item wording, display order and randomization.
Resolve questions from available materials yourself; use the existing question interaction only
for a specific unresolved material or scientific choice. The user reviews the relevant scope, not a checklist
of every field. Missing original question wording cannot become a reported or verbatim prompt: offer a
separate `variants/<name>/` proposal with exact changes for confirmation. Never enable a modified original
silently; never run an unapproved variant through the original-study route. Actual model calls still require
Simulation's explicit scope/model/cost approval. A request to prepare or run is not a payment approval.

## 3. Save a protocol in checkpoints

Start a blocked draft from [DRAFT_PROTOCOL.json](DRAFT_PROTOCOL.json). Replace its example metadata and
arms with the source-backed study map. Set `meta.title` to the exact title printed on the paper and
record the source files under `meta.sources`. The app's draft completion check requires both.
Keep `schema_version: "1"` and use the empty stage only for an
unprepared draft. Consult `.opencode/hsenv/schema/protocol.v1.json` for schema questions. Include every
blocked study.
Save small JSON object patches in `.humanstudy/tmp/`, then apply:

```
python .opencode/skills/build/protocol_io.py .humanstudy/tmp/patch-01.json --expected-hash absent
```

The helper prints the current raw-file SHA-256. Use it as `--expected-hash` for the next patch. Re-read after a
conflict; never force overwrite. Object keys merge; arrays replace as a whole, so preserve existing unaffected
entries. Never delete researcher changes. Refine uses proposals rather than silently replacing an accepted file.

Preserve all available background, research questions, hypotheses, conclusions and limitations in the scholarly program with citations;
absence in the paper is explicit, never a fabricated hypothesis. Keep unavailable auxiliary items in omitted,
with their reasons and effects on the replay scope. Exact timing/click exclusions and unsupported analyses must
be declared rather than silently claimed reproduced. Uncertainty is allowed in a finished draft.

## 4. Check the saved draft

For the shared schema and mechanical checks, set `PYTHONPATH=.opencode/hsenv` and run:

```
python -m hsenv.schema_check protocol.json --kind protocol
python -m hsenv.checks protocol.json --source-text paper=sourcetext/paper.txt
```

Keep reports under review/. Schema and reference checks must pass. If no arm is runnable, keep the valid
blocked draft and explain why. Leave `high_fidelity` for an independent review.

Write study.json using `.opencode/hsenv/schema/study.v1.json`, matching id and schema version; record a canonical
JSON SHA-256, the source authors/year/licences, actual check status and evidence paths. Never invent metadata.
The app separately checks the exact saved draft; an agent's PASS message is not a completion certificate.

## 5. Views

Generate `artifacts/preview.html` with the preview skill:
`python .opencode/skills/preview/make_preview.py`.
This costs no model calls and shows seeded participant paths, not exhaustive behavior. It is bound to the
protocol's current bytes. Regenerate after accepted changes; stale views must not stand in for the current study.
Other artifacts are optional and query-driven, never a prerequisite to inspecting the protocol.

## 6. Report

Stop the initial build when the scholarly program is complete, the protocol is structurally valid, every identified study is included or explicitly not prepared/blocked,
sources/citations and missing items are saved, and the participant preview is prepared. Say plainly what is
ready, what is missing and which analyses are outside scope. A current experiment preview does not replace the research overview. Do not claim a human replication or independent
review. Do not run a paid simulation, download private sources, or publish a study as part of a build.
