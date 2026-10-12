# The Study document: 12 sections

Source: the reading framework from our AI-social-science collaborator (2026-10-12). The Study tab
renders `program.json` as a document in these sections. Not every item must appear on screen: a
section shows what the program states, in one line per item, and everything else is one "Ask ↗"
away (the agent answers from the paper). Headings are the only text the view adds.

Paper-level sections (01–03, 10–12) appear once; study-level sections (04–09) repeat per study
behind the study switcher. Default open: 01, 03, 06 and 12; the rest start folded, remembered
per project.

| # | Section | What the program holds | Node kind / field ids | Status |
|---|---|---|---|---|
| 01 | Paper overview | title, authors, year, venue, DOI, version read; method type; one-paragraph summary | `source` (+ new optional `source.doi`, `source.venue`, `source.version`), node kind `overview` with fields `method-type`, `summary` | new kind |
| 02 | Research questions & hypotheses | questions; background and gap; theory and key concepts; hypotheses; scope conditions | `background` (fields `question`, `gap`, `theory`, `concepts`), `hypothesis` (fields `statement`, `scope`) | existing |
| 03 | Study map | each study's aim; relations between studies; which questions/hypotheses each study tests | `studies[]` (+ `dependsOn`), `hypothesis.studyIds`, relations `tests` | existing |
| 04 | Participants & context | setting; participant types and roles; recruitment and eligibility; N recruited / completed / analysed; characteristics; unit of analysis; pay and incentives; attrition and exclusions | `participants` fields `setting`, `roles`, `recruitment`, `eligibility`, `n-recruited`, `n-completed`, `n-analysed`, `characteristics`, `unit-of-analysis`, `compensation`, `attrition` | existing kind, field ids fixed |
| 05 | Design & conditions | design type; conditions and what differs; control; assignment; order and counterbalancing; blinding and manipulation checks | `design` fields `type`, `control`, `assignment`, `order`, `blinding`, `manipulation-check`; `condition` nodes; `conditionIds` | existing |
| 06 | Task, procedure & materials | task and goal; procedure steps and timing; instructions and stimuli (verbatim); available actions and visible information; feedback and payoff rules; stopping rule | `procedure`, `steps[]` (`rule`, `visibleIds`, `next`), `material` nodes (verbatim) | existing |
| 07 | Variables & measures | constructs and operationalisation; IVs; DVs; other variables (covariates, moderators, mediators); scales and scoring; timing and record unit | `variable` fields `role` (iv/dv/moderator/mediator/covariate), `type`, `observation-unit`, `scale`, `scoring`, `timing`, `definition`; `record` nodes | existing |
| 08 | Analysis | aim and comparison; data included and exclusions; statistical method; decision criterion; qualitative coding; robustness checks | `analysis` fields `aim`, `inputs`, `method`, `criterion`, `coding`, `robustness` | existing |
| 09 | Results | per-condition descriptives; effect size and direction; uncertainty; test statistics; subgroup/condition differences; qualitative themes | `result` nodes (`result_kind = reported`) fields `descriptives`, `effect`, `uncertainty`, `test`, `heterogeneity`, `themes` | existing |
| 10 | Findings & contributions | answer to the question; hypothesis support; mechanism (tested vs speculated); theoretical and practical contribution; design principles | node kind `finding` fields `answer`, `support`, `mechanism-tested`, `mechanism-proposed`, `contribution`, `design-principles` | new kind |
| 11 | Validity, limitations & replication | credibility of the inference; generalisability; limitations; replications the paper itself reports; availability of materials, data, code, preregistration | node kind `limitation` fields `validity`, `scope`, `limitations`, `replications`, `openness` | new kind |
| 12 | Simulation scope | which steps an agent can perform; which roles are simulable; which conditions can be expressed; which outcomes are observable; limits | node kind `simulation` fields `steps`, `roles`, `conditions`, `outcomes`, `limits`; plus the package readiness and the program's issues | new kind; agent assessment |

Rules that stay:

- Every item is a program field with its citation; `missing` stays visibly missing.
- Sections 09 and 10 are kept apart: 09 is what the paper reports (numbers), 10 is interpretation.
- Section 12 is the agent's assessment, labelled `origin: implementation` (never a paper fact), and
  it must agree with `package/<slug>/study.json.readiness` and the blocking issues.
- Section 11 "replications" means only what the paper itself says; the agent does no literature
  search (external research is opt-in).

## Questions for the collaborator (2026-10-12)

1. **04 "unit of analysis" vs 07 "record unit"**: both exist. Proposal: 04 keeps the *sampling*
   unit (who was recruited and paid: person, team, firm), 07 keeps the *observation* unit (what one
   row of data is: a choice, a rating, a round). The replay package already distinguishes
   sampling / assignment / observation units, so this maps one-to-one.
2. **Paper-level vs study-level**: 01–03 and 10–12 once per paper, 04–09 once per study. For a
   one-study paper everything reads as one document. Is that the intended reading order, or should
   10–12 also be per study when studies differ a lot?
3. **11 "replications and consistency"**: we will only record replications the paper itself cites
   or reports. Searching other literature is off by default (scientific rule: no external
   research without an explicit source). Is that acceptable, or should "Ask the agent" be allowed
   to search when the user asks?
4. **12 "which roles are not suitable"**: this is a judgement, not a fact from the paper. We label
   it as the agent's assessment and tie it to the package readiness. Should the researcher be able
   to override it with their own judgement (origin `researcher`)?
5. **Qualitative studies**: interviews and observation have no `steps` in the sense of a
   participant procedure. 06 would show the interview protocol as materials and the session as
   one step. Is a lighter 06 acceptable for those, or should 06 be hidden and 08's coding items
   carry the weight?
6. **How much on screen**: our plan is one line per item (the field's value, truncated with "…"),
   section folded except 01, 03, 06, 12, and "Ask ↗" on every section. Items the paper does not
   state are listed as "not stated" only inside the folded section, so the top of the document
   stays short. Any item you want always visible?
