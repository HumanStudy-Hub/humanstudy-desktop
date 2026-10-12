---
name: analyze
description: Run a Python analysis of the study (reported statistics, effect sizes, replay results, design summaries) and write figures plus a markdown report with the code to artifacts/. Use when the researcher asks for numbers, statistics, plots, comparisons or effect sizes.
---

# Analyze: Python to artifacts/

## Inputs

Use only `program.json`, `paper.pdf`, files in `sources/`, and run outputs present in the
project (for example `artifacts/package/**/` session logs). Never fabricate data or
statistics. If a needed number is not available, say so and name the program field or issue.

## Procedure

1. Write the script to `artifacts/<name>.py`. Use standard scientific Python (pandas, numpy,
   scipy, statsmodels, matplotlib). Fix random seeds. No network.
2. Run it. Save figures as `artifacts/<name>-<figure>.png` (300 dpi, labelled axes, units,
   n per group in the caption or legend).
3. Write `artifacts/<name>.md` containing:
   - the question answered;
   - data sources, each with its program id and page citation (`p. N`);
   - the full code in a fenced block (or the script path plus the key code);
   - results with test, statistic, df, p, effect size and CI where computable;
   - figures embedded by relative path;
   - limitations, including anything `missing` or `derived` (with its derivation).
4. Keep three kinds of numbers separate and labelled: **reported** (from the paper),
   **derived** (computed from reported values, derivation stated), **observed** (from a replay
   run). Never present an observed or derived number as reported.

Reply with the paths written and the main result in one or two sentences.
