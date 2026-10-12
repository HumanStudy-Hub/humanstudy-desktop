---
name: visualize
description: Write one self-contained, offline HTML view of the Human Program (participant flow, condition comparison, participant screens, or a researcher-requested view) to artifacts/. Use when the researcher asks to see, diagram, compare or visualize the study.
---

# Visualize: one HTML view in artifacts/

The view is derived from `program.json`; it never decides or adds study facts.

## Rules

- Write exactly one file, `artifacts/<short-kebab-name>.html`. Inline all CSS, JS, fonts and
  images. **No network**: no CDN, web fonts, remote images, analytics or fetch calls.
- Every rendered element that shows program content carries `data-program-id="<node|step|field
  id>"` (fields as `<nodeId>/<fieldId>`) and a visible citation: `p. N` from its evidence
  `locator.page`, `file` for a material path, or `no source` when it has no evidence. Put the
  page in `data-page="N"` too, so the app can open the PDF there.
- Text from the program is shown as written. `verbatim` text is never shortened or reworded; if
  space is short, truncate visibly with an ellipsis and keep the full text in a tooltip or
  expandable block.
- Arrows only from `steps[].next`. Where order is not stated, show no arrow (use `·`).
- Conditions only from `condition` nodes and `conditionIds`. Never group, colour or align by
  title similarity. Branch alternatives are columns of their own subtrees.
- Show `missing` and `check` items distinctly (e.g. amber), never as settled facts.
- Labels other than headings come from the program. Headings are the only text the view adds.
- Support light and dark (`prefers-color-scheme`), readable at narrow widths.

## Common views

- **Participant flow**: steps in `next` order per study, repeats and branches marked, actors
  and what each sees (`visibleIds`).
- **Compare conditions**: one column per condition node; condition materials side by side with
  differing words marked.
- **Participant screens**: what a participant sees at each step, from material nodes, verbatim.

After writing, check: the file opens with no network requests, every program-content element
has `data-program-id`, and every id exists in `program.json`. Reply with the file path and one
line on what it shows.
