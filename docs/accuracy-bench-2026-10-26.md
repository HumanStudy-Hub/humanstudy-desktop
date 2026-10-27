# Build accuracy on HumanStudy-Bench (2026-10-26)

**Short answer.** For papers with a text layer, the program recovered:

| Measure | Recovered |
| --- | --- |
| Curated sample sizes | 97% |
| Reported statistics | 96% |
| Data points | 88% |
| Curated materials that are printed in the paper, word for word | 83% |
| Quotes found on the page they cite | 99% (897/903) |

Scanned papers are weaker, and one scanned paper could not be built at all.

## Setup

All 15 Bench papers were built from the PDF alone with the standalone `humanstudy` skill:

- one fresh non-interactive Claude Code session per paper (Sonnet);
- the same prompt for every paper;
- no access to the ground truth;
- no human help.

Each program was then scored with `eval/bench/score.py` against Bench's curated
`ground_truth.json`, `specification.json` and `materials/`. Only curated values that are printed in
the paper count. Bench curators sometimes derive values: per-condition n computed from a total,
sums, and for study_014 numbers taken from a later LLM paper. They also summarise rather than quote
many materials (98 of 158 material texts are not in the paper). Those are reported as
`notInPaper` and not held against the program, because inventing them would be wrong.

Raw scores: `eval/bench/results-2026-10-26.json`. Programs are not committed, since they contain
the papers' materials.

## Results

Model: sonnet

| Study | Text | Built (min) | Checks | Ready | Sample sizes | Statistics | Data points | Materials ≥90% | Quotes found |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| study_001 | text | 8.5 | program ✓, package ✓ | blocked | 3/3 | 4/5 | 54/90 | 6/6 | 82/84 |
| study_002 | scan | 5.3 | program ✓, package ✓ | blocked | 4/4 | 12/12 | 55/57 | 7/78 | 0/4 |
| study_003 | text | 4.5 | program ✓, package ✓ | ready | 4/4 | 8/9 | 21/21 | 7/7 | 43/43 |
| study_004 | text | 7.2 | program ✓, package ✓ | ready | 7/7 | 1/1 | 17/17 | 8/8 | 78/78 |
| study_005 | text | 2.2 | program ✓, package ✓ | ready | 2/2 | 4/4 | 8/8 | 4/5 | 24/24 |
| study_006 | text | 11.7 | program ✓, package ✓ | ready | 9/10 | 36/37 | 82/85 | 10/16 | 163/163 |
| study_007 | text | 9.4 | program ✓, package ✓ | blocked | 1/1 | 7/7 | 19/19 | – | 121/121 |
| study_008 | text | 9.3 | program ✓, package ✓ | ready | 3/3 | 8/8 | 31/31 | 5/6 | 133/133 |
| study_009 | scan | 3.4 | program ✓, package ✓ | blocked | 3/3 | 2/4 | 33/50 | 0/6 | scanned |
| study_010 | text | 6.0 | program ✓, package ✓ | blocked | 2/2 | 3/3 | 13/13 | 1/2 | 63/63 |
| study_011 | – | 0.3 | program ✗, package – | – | – | – | – | – | – |
| study_012 | scan | 5.7 | program ✓, package ✓ | ready | 0/2 | 7/7 | 16/16 | 1/6 | scanned |
| study_013 | text | 6.9 | program ✓, package ✓ | ready | 1/1 | 5/5 | 40/40 | 10/10 | 58/58 |
| study_014 | text | 5.0 | program ✓, package ✓ | blocked | 1/1 | – | 3/4 | – | 69/69 |
| study_015 | text | 5.1 | program ✓, package ✓ | ready | – | – | – | 3/5 | 63/63 |

Text PDFs: sample sizes 33/34 (97%) · statistics 76/79 (96%) · data points 288/328 (88%) · verbatim materials 54/65 (83%)

Scanned PDFs: sample sizes 7/9 (78%) · statistics 21/23 (91%) · data points 104/123 (85%) · verbatim materials 8/90 (9%)

Build time median 5.7 min; total cost $17.22

Quotes found on their cited page (where a text layer exists): 897/903 (99%)

All 14 programs that were built pass `check_program.py --complete` and `check_package.py`.
8 are ready to run; 6 are blocked by decisions the paper leaves open, which is a correct outcome.

## What the misses are

1. **Scanned PDFs** (study_002, 009, 012; text layer of 15–70 characters).
   - The agent read the page images, so the quotes cannot be checked mechanically.
   - study_012 missed both sub-study sample sizes.
   - Verbatim materials score 9%. This number is not reliable, because without a text layer the
     curated summaries cannot be filtered out.
   - study_011 (scanned) was not built at all. The agent stopped and asked whether it could run the
     local `tesseract` for OCR, because the skill says there is no OCR. This is correct behaviour, but
     it is the largest gap in the pipeline.
2. **Large tables are extracted only in part.**
   - study_001 recovered 54/90 data points. Its trait-rating table (Table 2: per-story differences
     such as 29.1 and 41.6) was summarised rather than transcribed.
   - The other text-PDF studies recovered 85–100% of their data points.
3. **Statistics that are aggregates across sessions or problems**: "6 out of 7 sessions reject",
   "t-values ranging from < 1 to 6.19", and one percentage pair in study_003. These are curators'
   summaries that span several places in the paper.
4. **One missed sub-study**: study_006 Experiment IXa (n = 55).

## What this does and does not show

It shows that, for text PDFs, nearly all curated sample sizes and statistics can be found in the
program, and that the program's quotes are on the pages they cite.

It does not show:

- that every condition, step and instruction is present (completeness of the design);
- that summarised fields are right;
- that the program can be used to replicate the study.

Those still need a researcher's review or an expert study like the CHI one.

Recall is measured against Bench's scope, which differs from the paper in both directions.

## Next

- **OCR for scanned papers.** Let the build use `tesseract` when a page has no text layer, keep
  those quotes `unverified`, and have the quote check compare them against the OCR text.
- **Tables.** Add an instruction to the build to transcribe printed result tables cell by cell into
  `descriptives`, instead of summarising them.
- **Repeat with Haiku**, the app's default hosted model, to see the gap.
