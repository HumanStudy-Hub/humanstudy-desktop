---
name: visualize
description: Make an interactive, self-contained HTML view of the study in artifacts/ with the HumanStudy artifact kit (participant flow diagram, condition comparison, sample/attrition, reported results chart with citations, human vs simulated chart, participant screens, or any view the researcher asks for). Use when the researcher asks to see, diagram, chart, compare, plot or visualize anything about the study, and after build/simulate as those skills say.
---

# Visualize: an interactive view in artifacts/

A view arranges `program.json` (and, for simulations, a run's own outputs) so a researcher sees it
at a glance. It never decides or adds study facts. Build every view on the kit in
`.opencode/artifact-kit/` (charts, flow diagrams, citation chips, amber gaps, light/dark, the click
bridge to the paper) instead of hand-drawing HTML and CSS.

## How to write one

1. Read `program.json` (and the source files a view quotes, e.g. `sources/materials/*.json`).
2. Write `artifacts/<short-kebab-name>.html` as a small page that references the kit by name and
   calls its components from one inline script at the end of `<body>`:

   ```html
   <!doctype html>
   <html lang="en">  <!-- "zh" when the researcher writes Chinese: kit labels follow it -->
   <head>
     <title>Study overview</title>
     <link rel="stylesheet" href="hs-kit.css">
     <script src="hs-kit.js"></script>
     <!-- only when you need a free-form Chart.js chart: <script src="chart.umd.min.js"></script> -->
   </head>
   <body><main class="hs-page">
     <p class="hs-eyebrow">Author, Author &amp; Author (year)</p>
     <h1 class="hs-title">Choice framing shifted willingness to pay</h1>
     <div class="hs-takeaways"><p>One or two sentences: what this view shows and what to look at.</p></div>
     <h2 class="hs-h2">Mean willingness to pay by condition</h2>
     <p class="hs-sub">Table 2, p. 6. US dollars; whiskers ±1 SD as reported.</p>
     <div id="results"></div>
   </main>
   <script>
     HS.results('#results', { yLabel: 'Willingness to pay ($)',
       groups: [
         { label: 'Mug', id: 'result-wtp', page: 6, bars: [
             { label: 'Gain frame', mean: 4.10, sd: 1.2, n: 48 }, { label: 'Loss frame', mean: 5.85, sd: 1.6, n: 47 }] },
         { label: 'Pen', id: 'result-wtp', page: 6, bars: [
             { label: 'Gain frame', mean: 2.05, sd: 0.9, n: 48 }, { label: 'Loss frame', mean: 2.95, sd: 1.1, n: 47 }] }] })
   </script>
   </body></html>
   ```

3. Run `python .opencode/artifact-kit/inline.py artifacts/<name>.html`. It inlines the kit (and
   Chart.js only if referenced), embeds a slim `program.json` so components resolve ids, pages and
   gaps themselves, adds a no-network policy, and checks the page. Fix every problem it prints and
   re-run until it prints `PASS`. Never paste the kit or Chart.js yourself.

## Components (window.HS)

All take an element or selector first. Ids are program ids; the kit looks up their cited page,
quote and open issues, so pass `id` and let it cite. Pass `page` only for a number the program
does not hold (e.g. a table cell you read on that page).

| Call | Draws |
|---|---|
| `HS.overview(el, {study?})` | One study at a glance (tabs when several): N tiles, sample flow, procedure diagram, conditions, open questions. |
| `HS.flow(el, {study})` | Procedure as an SVG diagram from `steps[].next`: arrows only where the order is stated, loops marked, steps without stated order shown with `·`, amber where a step has an open issue. |
| `HS.conditions(el, {study})` or `{conditions:[{id, title, text, page}], shared:{text, page}}` | One column per condition node; `text` is the condition's verbatim material; words that differ between conditions are highlighted. |
| `HS.attrition(el, {study})` or `{stages:[{label, n, id, page}]}` | N at each stage (recruited, completed, analysed) and the loss between; missing stages amber. |
| `HS.results(el, {yLabel, unit, yMin, yMax, reference:{value,label}, groups:[...]})` | Bar chart of means with error bars. A group is `{label, id, page, bars:[{label, mean, sd\|se\|ci:[lo,hi], n}]}` for several reported series (bars with the same label share a colour and a legend entry, e.g. `'Gain frame'` / `'Loss frame'` under each item), or `{label, id, page, human:{mean, sd\|se\|ci, n}, sim:{values:[...]}}` for human vs simulated. Every group needs the `id` of the result node it comes from. Spread is drawn only when reported, else one amber "Spread not reported in the paper"; a missing value is an amber gap; simulated bars are hatched with the "Simulation — not human data" label, `sim.values` (one per session) draws the dots and 95% CI. |
| `HS.forest(el, {xLabel, rows:[{label, id, human:{est, ci, page}, sim:{est, ci}}]})` | Effect sizes with intervals, human vs simulated per row. |
| `HS.stats(el, [{label, value, id, page, note}])` | Stat tiles; a `null` value is shown amber "not reported". |
| `HS.issues(el, {study})` | The program's open questions for a study as amber cards with an "Ask the agent" button. |
| `HS.manifest(el, {model, temperature, seed, ...})` | Run settings as a definition list. |
| `HS.tabs(el, [{id,label}], (id, panel) => ...)` | Tabs, e.g. one per study or condition. |
| `HS.chart(el, chartJsConfig)` | Any other Chart.js 4 chart (histogram, scatter, line), themed; mark simulated datasets `simulated: true`. Needs `<script src="chart.umd.min.js">`. |
| `HS.cite(page, {quote, id})`, `HS.citeId(id)`, `HS.missing(text)`, `HS.simLabel()`, `HS.askButton(label, prompt)` | HTML strings for chips you place in your own markup. |

CSS classes for your own markup: `hs-page`, `hs-eyebrow`, `hs-title`, `hs-lede`, `hs-takeaways`,
`hs-h2`, `hs-sub`, `hs-card`, `hs-grid`, `hs-verbatim`, `hs-chip hs-missing`, `hs-foot`.

## Rules

- Use only what the program (or the run's outputs) states. Never invent steps, conditions,
  wording, numbers or order. Where something is missing, show it amber as "not reported" /
  "not stated" (`HS.missing`), never a guess and never a silently empty space.
- Every mark showing program content is clickable back to its source: the kit does this for its
  components. In your own markup, give each element `data-program-id="<node|step|nodeId/fieldId>"`
  and a visible chip from `HS.citeId(id)` or `HS.cite(page)`; `no source` when there is no evidence.
  A click opens the paper at that page in the app; `data-ask="<question>"` prefills the chat.
- `verbatim` text is quoted exactly (`hs-verbatim`); if long, it scrolls in its card, it is not
  shortened or reworded. Labels other than headings and one-sentence explanations come from the
  program.
- Arrows only from `steps[].next`; conditions only from `condition` nodes and `conditionIds`.
  Never group, colour or align by title similarity.
- Reported (human) and simulated numbers are never mixed without the kit's labels; a simulated
  value is never shown as reported.
- No network: no CDN, web fonts, remote images, `fetch`. Images you made (e.g. `results.png`) may
  be referenced with a relative `<img src>`; `inline.py` embeds them.

## Quality bar

A psychologist should understand the view in ten seconds and trust every mark in it.

**Choosing the form** (chart-selection rules after common data-visualization guidance):

| What the paper compares | Use |
|---|---|
| Means or percentages across conditions / groups | `HS.results`; the paper's comparison sits inside one group (e.g. frame A vs B per item), the grouping variable across groups |
| Effect sizes or intervals across studies / outcomes | `HS.forest` |
| Sample sizes through the study | `HS.attrition` |
| Order of what participants did | `HS.flow` |
| What differs between conditions | `HS.conditions` |
| A single statistic (F, t, a count) | `HS.stats` tile with its citation; never a one-bar chart |
| Distributions of simulated sessions, scatter, time course | `HS.chart` (Chart.js): histogram, scatter, line |

Never a pie chart. Bars start at zero. Exact numbers sit on the marks, so a table is needed only
for lists of text.

**Design discipline** (adapted from Anthropic's `frontend-design` skill, Apache-2.0, see
`third_party/`; tuned for reading research):

- **One idea per view.** The `hs-title` states the finding or the question in a sentence
  ("Loss framing raised willingness to pay"), not the data type ("Results chart").
  Two sentences of `hs-takeaways` at most.
- **Restraint.** The kit already sets a three-size type scale, Okabe-Ito colours (human blue,
  simulated vermillion, amber only for gaps), light/dark and focus states. Do not add colours,
  fonts, shadows, gradients, emoji, icons or extra cards; no inline `style` except layout widths.
- **Structure is information.** Headings, rules and numbering only where they mean something: no
  ALL-CAPS labels, no `01 / 02 / 03` markers unless the content is a real sequence (procedure
  steps), no "A · B · C" meta strings, no decorative eyebrow above every heading (one citation line
  above the title is enough).
- **Line length under 80 characters** for prose (`hs-lede`, `hs-sub` and `hs-takeaways` already
  cap it); verbatim material in `hs-verbatim`.
- **Words in the paper's terms.** Axis labels name the measure and unit as the paper does; the
  `hs-sub` line under each chart says which table or page the numbers come from and what a bar
  is. Sentence case, plain verbs, no selling.
- **Self-critique.** After `PASS`, reread the page source once against this list and remove one
  thing that does not help the reader.

## Common views (from the HumanStudy Hub view templates)

- **Study overview** (`study-overview.html`): `HS.overview('#app')` under a title and takeaways.
- **Participant flow**: steps in order, an arrow only where a next edge exists; branch alternatives
  side by side; repeats as loops; write "order not stated" where steps have no next edge
  (`HS.flow`).
- **Compare conditions**: conditions side by side, shared material once, differing words marked;
  if the program states no conditions, say so plainly instead of inferring them
  (`HS.conditions` with the verbatim text of each condition's material from `sources/`).
- **Participant screens**: screen by screen what one participant sees, only participant-visible
  materials (`visibleIds`), quoted exactly; a tab per condition; grouping, order or wording the
  program does not state marked "not stated".
- **Reported results** (`reported-results.html`): `HS.results` / `HS.forest` with the paper's
  numbers from `09 Results`, one chart per comparison, every bar cited.
- **Human vs simulated**: see the `simulate` skill.

After `inline.py` prints PASS, reply with the file path and one line on what it shows.
