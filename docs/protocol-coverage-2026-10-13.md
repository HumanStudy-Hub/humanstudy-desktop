# Protocol coverage and fixes — 2026-10-13

Reference: [Protocol](https://docs.google.com/document/d/1efl-MOKyrTcszQRQELwAE56AjSHsuqYTp5-cDeMo_QU/edit).
Scope: HumanStudy Desktop's bundled Build Study instructions, Human Program v2 renderer,
source routing, session history and consented research capture. No simulation was run and
no release was published. This checks implementation coverage, not factual correctness of
every existing extracted paper.

| Protocol area | Data and delivery |
| --- | --- |
| 01 Paper overview | Source title, authors, venue, DOI, version; overview year, method and summary. Publication year now has an explicit field and label. |
| 02 Questions and hypotheses | Background question, gap, theory, concepts; hypothesis statement and scope. Visible by default. A method without hypotheses must not acquire invented ones. |
| 03 Studies in this paper | Every study remains selectable, including analyses and incomplete procedures; aims, dependencies and hypothesis links remain in the study map. |
| 04 Participants and context | Recruitment, eligibility, sample counts, characteristics, units, compensation and attrition. Sampling and analysis units remain distinct. |
| 05 Design and conditions | Explicit condition nodes, assignment, comparison, control, order, blinding and checks. Condition details are expandable; names alone no longer conceal unresolved fields. |
| 06 Tasks, procedure and materials | Explicit steps, actor/input/output/visibility bindings, instructions and stimuli, actions, feedback/payoff and stopping rules. Materials expand into complete fields and citations. |
| 07 Variables and measures | Construct definitions, IV/DV and other roles, scales/scoring, measurement timing and observation units. |
| 08 Analysis | Aim, included data, statistical method, decision criterion, qualitative coding and robustness. |
| 09 Results | Descriptives, effects, uncertainty, tests, heterogeneity and qualitative themes. The build contract requires reported results to stay distinct from simulated observations. |
| 10 Findings and contributions | Answers, hypothesis support, tested/proposed mechanisms, contributions and design principles. |
| 11 Credibility, limitations and replication | Validity, generalisation, limitations, replications cited by the paper, and availability of materials/data/code/preregistration. No unsolicited literature search. |
| 12 Simulation scope | Separate review view with eligible steps, roles, conditions, observable outcomes and boundaries. Confirmation is disabled for incomplete scope or blocking issues. |

The document uses familiar research terms, progressive disclosure and a selected study;
it does not require eleven expanded panels at once. Unknown details remain available in the
data and to the agent. The agent must distinguish an unextracted fact, an unreported fact and
a feature that does not apply to the method. The schema is permissive about node field ids:
old programs do not automatically gain facts just because a view now supports a field.

## Simulation confirmation

An explicit run request in chat opens scope review. Ordinary questions about simulation stay
in chat. Confirmation records the selected study, the five reviewed fields and SHA-256 of
the exact current program file. A concurrent file change prevents confirmation. Bundled
agent instructions require checking approval, matching the current hash, resolving blocking
issues and staying within that study's scope. An adapter unable to isolate the approved scope
must stop. This combines UI review with agent instructions; it is not a sandbox that prevents
every possible arbitrary shell command. A real end-to-end agent run is still needed for that
execution-path acceptance check.

Existing projects receive updated build/simulate skills only when their files still match
the previous bundled defaults. Custom instructions are preserved. No existing program is
automatically rewritten or treated as freshly verified.

## Source integrity

Source id, explicit path, page and full quote survive a citation click. Local attachments
open their own file, and unknown attachments show an unavailable-resource message instead
of substituting the main paper. PDF loading cancels stale tasks when switching resources.
Quote highlighting and PDF text selection are separate outstanding interaction work;
this change does not claim to implement them.

## Full research records

Tool inputs/outputs, recovered conversation context and evidence quotes are no longer cut.
Long text and large metadata use complete gzip blobs; text above 4 MiB uses ordered parts
and a manifest. Unicode is decoded after concatenating bytes, so boundaries do not lose
characters. Program/file recording cutoffs were removed. Failed uploads, old offline
events and data beyond disk warning thresholds remain on disk. Exports include pending
events and pending replay files for the signed-in account. Known credentials remain masked.

Cloud infrastructure still has finite request/object limits. A rejected oversized recording
stays locally recoverable rather than being dropped. Model context limits can reject a very
long restored conversation; there is no silent clipping fallback.

The live database still has a 30-day timestamp rule. Its removal was rejected by automatic
approval review and is awaiting explicit owner approval. A local migration is prepared in
the web repo; new events can upload while old rejected events remain pending.

## Verification

Tests cover analysis-only rendering, attachment routing, complete long quotes, incomplete
and scoped simulation assessments, private credential handling, large restored histories,
Unicode blob reconstruction, persistent queues, rejected uploads, and fresh-event delivery
while old offline events are rejected. Type checking and the Electron production build are
also required. No production deployment, notarisation or live simulation was performed.
