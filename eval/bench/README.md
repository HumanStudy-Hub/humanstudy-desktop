# Build accuracy against HumanStudy-Bench

How much of a paper's curated facts does the build pipeline recover? HumanStudy-Bench's studies
each have human-curated ground truth (`source/ground_truth.json`, `specification.json`,
`materials/`). `run.py` builds every Bench paper from its PDF alone with the standalone
`humanstudy` skill (one fresh Claude Code session per paper, ground truth never shown), and
`score.py` compares each `program.json` with the curated facts:

| Measure | Counted as found when |
| --- | --- |
| Sample sizes | each sub-study `n` appears in the program's participants, design, conditions or results |
| Statistics | every number of a reported test (e.g. `F(1, 312) = 49.1`) appears together in one field or quote |
| Data points | each curated mean, percentage or count above 10 appears (a percentage may appear as its complement) |
| Materials | share of each curated material text found word for word in the program's verbatim fields |
| Quotes | `check_quotes.py`: program quotes found on their cited page |

These are recall measures. Read the misses: Bench curators sometimes derive values the paper does
not print (per-condition `n` from a total, corrected counts), summarise materials instead of quoting
them, or cover fewer studies than the paper. A miss of a derived value is the program behaving
correctly (it does not invent numbers).

```bash
python eval/bench/run.py --bench ../HumanStudy-Bench --work <scratch>/bench-run --python <python with pypdf>
python eval/bench/report.py <scratch>/bench-run/results.json
python eval/bench/score.py ../HumanStudy-Bench/studies/study_001 <project>/program.json   # one study
```

Programs stay in the work folder; they contain the papers' materials and are not committed.
Results: see `docs/accuracy-bench-*.md`.
