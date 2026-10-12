---
name: refine
description: Change an existing artifact or program.json through a reviewable proposal (corrections, researcher decisions, codesign changes, view edits). Use when the researcher asks to fix, change, update, edit or redesign something that already exists.
---

# Refine: reviewable changes

Never edit the accepted file in place. Write a proposal beside it and let the researcher accept.

## Program changes

1. Read `program.json` and the item(s) the researcher refers to (ids, selected text, page).
2. Write the complete revised program to `program.proposed.json`. Validate it against
   `schema/human-program.schema.json`.
3. Change only what was asked. Keep every unaffected id, field and evidence record identical.
4. Classify each change:
   - **Correction to match the source** (`reconstruct`): fix the field, keep or add evidence with
     an exact quote and page. Origin follows the source (`verbatim`/`reported`/`derived`).
   - **Researcher decision** filling a `missing`/`decision` item: origin `researcher`, state
     `confirmed`; resolve the matching issue. Never relabel it as a paper fact.
   - **Codesign departure**: set `intent: "codesign"` if not already, origin `researcher`, and
     add an issue recording the departure from the original and its likely effect.
5. Never rewrite a `verbatim` instrument unless the researcher supplies the corrected source
   text; then cite where it came from.
6. Write `artifacts/<YYYY-MM-DD>-change.md`: each changed id, before -> after, classification,
   evidence, and any new or resolved issues.

## Artifact changes

Write `artifacts/<name>.proposed.<ext>` with the requested edit, keeping the rules of the skill
that produced it (visualize: offline, `data-program-id`, citations; analyze: code and labelled
numbers). An artifact edit never changes study facts; if the request implies a fact change, make
a program proposal instead.

## Accepting

When the researcher accepts, replace the original with the proposal and delete the
`.proposed` file. If they reject, delete the proposal. Reply with a short summary of the change
and the proposal path.
