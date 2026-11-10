high fidelity
# Fidelity review 1: mazzarella2018politeness (Mazzarella et al. 2018)

Reviewer (independent opus agent; did not build the sandbox). Read: skills/README.md (Decided 11, 16), DESIGN §1–3, LESSONS (494, 559–568), STATUS, build_protocol.py, protocol.json, precedents (hall2024gettier, aiyer2023outcomebias, li2025mentalaccounting, manylabs1), paper text layer pp. 4–9, 11–12, page images pp. 5, 6, 8, 12 rendered with pypdfium2. Ran: engine driver, both arms, design(n=200, seed=1) = 400 sessions (s1 threat 97 / boost 103; s2 100/100), every State of s1-boost and s2-threat, failure paths on s1 (empty, None, off-list code, label instead of code, unknown id: all refused, State unchanged), unit tables; run_checks --no-write PASS, lint empty. Protocol sha256 reviewed: 7de536d7facdca4905fc544226c099c78c92638438544933e634de3c2c1ea160 (= STATUS).

## Must-fix
None. Judgement on the converter's omitted decision (meta.omitted_decision, omitted[0–2]): faithful; both arms stay runnable. Decided 16(d) forbids serving converter-written screens; none is served. "No source → missing, arm blocked" applies to screens the source shows were part of the task (LESSONS 494: a described instruction page). This paper describes no instruction or title page; its only screen statements are "(6a) and (6b) were displayed in two separate screens" (p. 5), "displayed separately in two steps" (p. 8) and the Appendix A line "Horizontal lines indicate where participants were asked to advance the text" (p. 12), all modelled as stages. Consent appears only as "All subjects gave written informed consent" (pp. 5, 8); consent pages are omitted with runnable arms in hall2024gettier, aiyer2023outcomebias, manylabs1. Decided 11 does not apply.

## Should-fix
R1-S1. meta.paper_inconsistencies[0] is wrong (paper p. 6, Tables 3–4). It claims the inner percentages (97%, 10%) are "truncated in print", reading "Proportion of total" percentages as counts ("44 of 45", "6 of 55"). The tables are consistent with integer counts: threat cells (Yes-Yes, Yes-No, No-Yes, No-No) = (2, 62, 8, 70) at n_t = 142, boost (42, 6, 54, 48) at n_b = 150 reproduce every printed inner, joint and marginal percentage; seven (n_t, n_b) splits work, 140/152 to 163/129. The truncation story fails on its own terms (1/45 = 2.2%, not the printed 3%). No target uses the inner percentages. Fix: delete the entry or replace with "Tables 3–4 are consistent with integer cells (e.g. 2/62/8/70 of 142 and 42/6/54/48 of 150); cell n not printed".
R1-S2. Yes/No option order is not labelled as an unstated order (item 4b). Source p. 5 "two options, “Yes” and “No.”"; protocol data.yes.cite / data.no.cite and stages.scq|icq.responses[0].options. Order (Yes first) is not printed; it sits only in a note on a verbatim text cite. Fix: add a derived order cite on the options with the alternative (No first, or side by side).
R1-S3. `required` for Study 2 is labelled `reported` from a Study 1 sentence (p. 5 "Participants were required to click on one of them"; p. 8 silent). Protocol: stages.scq.responses[0].cite, shared by both arms; its note says Study 2 "same task assumed". Fix: split per arm or label derived with the carry-over note.
R1-S4. meta.omitted_decision rationale should state the deciding distinction: no instruction or title page is described in the paper (contrast LESSONS 494); consent is booklet/HIT context; nothing converter-written is served (16(d)). It also lists "Europe PMC link" as searched, but STATUS records HTTP 403 (not read); say so.
R1-S5. analysis.effects[*].reported cite is labelled `reported` for a value computed by the converter (difference of two printed shares; value_note says "derived arithmetic"). Fix: label the value derived, citing the printed shares; keep Fisher p and OR as the reported test. (Printed ORs reproduce: 0.45 vs 0.32 → 1.74 (printed 1.7); 0.45 vs 0.125 → 5.73 (printed 5.7).)

## Checked and correct
1. Page structure (1, 1b, 1c, 10): story → utterance → scq → icq, icq only in Study 1 (`if arm == 's1'`), matches Appendix A row lines incl. the line between the two questions, p. 5 "always in this order", p. 8 "There was no conversational implicature question". One text per screen. No codebook/analysis code exists; no conflicting timing statements.
2. Verbatim texts (2, 2b, 2c, 14): both stories match pp. 5/8 and the p. 12 image character for character (incl. curly ’ in "audience’s"). Joining the condition word gives exactly the printed strings ("Hearing this, Denise tells you that “Some people hated/loved your speech.”"; "Given what Denise told you, do you think that it is possible that everybody hated/loved your speech?"). Appendix A bold marking is table typography, correctly not served. English stimuli, no translation, no reprs, no converter text on screen.
3. Widgets (3): two-option choice, required (p. 5), no sliders; engine-generic validation (source has none).
4. Assignment (4, 4b, 4c): between-subjects independent 50/50 draw, derived with balanced alternative; no subset values.
5. Visibility (5, 5b, 11): earlier screens in `seen`, reviewable false, derived cite gives the alternative; no payoff/feedback; single role.
6. Exclusions (6, 6b): 399−91−3−13 = 292, 398−87−2−15 = 294; click/RT rules not replayable, declared in exclusion_caveat; no analysis code exists.
7. Targets (7, 7b, 7c): all 14 match pp. 5–6, 8 (0.45/0.32/0.07/0.64/0.45/0.125 + eight "Proportion of total" cells; they sum to the marginals). Effects signed threat − boost, `two_groups`. No model coefficient, so no compareAs. Structured n_recruited / n_analysed on both arms.
8. No leakage (8): States carry only i1/i2, r1/r2, o1/o2.
9. Engine (9): required answer enforced, off-list codes and unknown ids refused, s2 icq/joint None.
10. Coding, arithmetic, hygiene (12, 13, 13b, 15, 15b): no coding; no bracketed percentages or rank tests; every target no_uncertainty; no archives/data opened; CC BY so no release_hold.
11. Lint block empty; one miss: S2 option-order cite (R1-S2), which `derived_order_no_alternative` does not scan on option labels.
12. STATUS current (sha, 4 stages, 14 targets, 3 effects, 13 verbatim).

## Check requests
- Nested-percentage feasibility lint for 2×2 tables printed as row percentages plus percentages of the total (would have caught R1-S1).
- Extend `derived_order_no_alternative` to choice options whose order is not printed (verbatim text cite with "order … not printed" in a note).
- Cross-arm `reported` lint: a `reported` cite on a response shared by several arms whose note says another study/arm is "assumed".

Sources consulted for the search for missing sources: Frontiers article page (no Supplementary Material, no Data Availability section; its only OSF links are for cited works); web search (unrelated works, no materials for this paper).
