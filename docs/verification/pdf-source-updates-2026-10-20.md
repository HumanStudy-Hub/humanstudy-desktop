# PDF, source evidence and update notices — 0.6.6

## Observed

- The owner's installed copy was 0.6.4 with a staged 0.6.5 update. During this
  investigation ShipIt finished installing 0.6.5 into `/Applications/HumanStudy Hub.app`.
  No owner process was forcibly stopped. A same-version installation loop was not reproduced.
- Two existing research projects contained short evidence fragments: one had 35
  quotes of 18–53 characters, another had 28 quotes of 48–104 characters. The UI
  opened only the first reference, and matching an opening fragment could incorrectly
  mark an incomplete longer quote as found. Existing project data was not modified.
- The PDF viewer extracted all pages' text when opened, measured repeated text
  prefixes, and retained visited text layers and raster canvases. These are avoidable
  sources of work and memory. A brief renderer sample was mostly idle; it does not
  establish that every reported UI stall has the same cause.

## Changes

- Extract PDF text only for visible pages or an explicitly requested citation;
  deduplicate page reads and yield between new reads. Release offscreen raster
  canvases and ordinary text layers, preserving text during selection and annotation.
  Pause rendering when the paper pane is hidden.
- Measure each word/whitespace chunk once instead of repeatedly measuring prefixes.
  Remove the old 5,000-word page cutoff; source text is not truncated.
- Match complete quotations. For explicit ellipses, every remaining segment must
  match uniquely and in order. Missing quotes are reported, not partially verified.
- Offer every reference in a source chooser, with full quotations. Verification
  keys include resource identity and the full quote, avoiding cross-file collisions.
- Strengthen the default build instructions to retain complete supporting sentences
  and necessary context, with multiple evidence entries where appropriate. Upgrade
  untouched default project skills using their prior hash; preserve custom skills.
  Existing short stored quotations still require agent re-extraction.
- Show current and downloaded versions in the update notice/settings. Remember
  “Later” per version across relaunches. Ignore stale events for the installed version.

## Verification

- Desktop regression suite: 69 passing checks before the final stale-version guard;
  update recovery/safe-shutdown tests additionally pass with the guard.
- Node and renderer TypeScript checks; production build.
- `pdf-page-cache.test.mjs`: lazy reads, concurrent deduplication, retry after failure,
  preservation of 6,001 words, linear measurement, strict complete-quote matching.
- `pdf-source.test.mjs`: real PDF.js and Electron with a generated 120-page PDF.
  Initial open reads 2 pages. Saves a two-page selection. Finds a two-line quotation
  on page 90 despite a page-89 citation, releases visited text/raster resources,
  supports zoom, and clears raster resources when hidden. Isolated userData only.
- `source-controls.test.mjs`: all references selectable, long quotation preserved,
  chooser escapes clipped cards, “Later” persists for the same version, newer
  versions still appear, and Restart invokes the installer action.

Release/signature/notarization and real public updater acceptance are recorded below
after completion. Windows remains a preview pending hardware verification.
