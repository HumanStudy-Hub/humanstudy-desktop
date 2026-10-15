# Simulation report: Corporate Chairman Vignette (exp-1)

- Approved scope: study exp-1, 20 AI participants per condition, model anthropic/claude-haiku-5.5. program.json SHA-256 53f7ab0e8dd27feddc4c9b332e2db99415e3b3c2915d1b2043230aecf58db875.
- Temperature 1.0, seed 20261015. Model calls: 42 (2 trial, 40 full run); unreadable or failed replies: 0.
- Assignment: exactly 20 per condition, shuffled from the seed (the paper says subjects were randomly assigned, p. 3).
- Question order: rating first, then intentionality (the paper's order, p. 3-4). The material JSON lists them the other way round. program.json issues exp-1-question-order is still open for the researcher.

## Reported (paper, p. 4) vs observed (AI)

| Measure | Paper (reported) | AI participants (observed) |
|---|---|---|
| Said intentional, harm | 82% (chi2(1,N=78)=27.2, p<.001) | 100% (20/20) |
| Said intentional, help | 23% (i.e. 77% said not intentional) | 0% (0/20) |
| Chi-square, this run (no correction) | chi2(1,N=78)=27.2 | chi2(1,N=40)=40.00, p=2.5e-10 |
| Blame (harm) and praise (help), 0-6 | 4.8 and 1.4, pooled over both experiments (p. 7), t(120)=8.4 | blame 5.65, praise 0.65 (exp-1 only), Welch t=32.3, p=3e-29 |
| Pooled rating-intentionality correlation | r(120)=0.53 (p. 7) | r=0.98, n=40 |

## Judgement by the paper's own criterion

The paper's claim is that intentionality judgments differ between harm and help. The AI run shows the same direction, with a
larger difference than the paper reports. The outcome is "replicated" by the direction-and-significance criterion. The size
is not comparable: the AI answers are all-or-nothing (every participant gave the same answer per condition), so the
chi-square is far larger than the paper's, and the blame and praise means are more extreme than the paper's pooled means.

## Limitations and adaptations

- One model, one temperature, one seed, 20 participants per condition. Results are AI behaviour, not human data.
- Experiment 2 was not run (not in the approved scope).
- The participant-facing introduction is missing from the source, so the adapter only adds a neutral answer-format line (audit entry procedure.instructions).
- The paper's blame/praise means pool both experiments; the AI means are exp-1 only.
- Random assignment and question order were settled from the paper text for the replay; the program's open decisions are unchanged.
