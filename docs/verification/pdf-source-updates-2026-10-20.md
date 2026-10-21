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

## Published release and actual upgrade

- PR #8 merged as `177a4210ca9f8a4217f1f93dc3c3eb67006aeebf`, tag `v0.6.6`.
  Release: https://github.com/HumanStudy-Hub/humanstudy-desktop/releases/tag/v0.6.6
- Release workflow `39542596372` passed. Both Mac architectures are signed,
  notarized and stapled; deep codesign verification, Gatekeeper and stapler validation
  passed. Packaged main/preload/renderer bytes match the tested production build.
- All nine Mac/update asset SHA-256 digests and sizes match GitHub's uploaded files;
  all four installer SHA-512 entries in `latest-mac.yml` were checked before publishing.
  Five Windows preview assets are present. No Windows or Intel hardware installation
  test was performed.
- An isolated signed 0.6.5 arm64 copy downloaded 0.6.6 from the public update channel,
  completed native Squirrel staging, installed on normal quit, and reopened as 0.6.6.
  The reopened app reported `state=none` after checking updates. Codesign and Gatekeeper
  accepted the actual installed copy.
- All 35 sample/project/source/chat/settings files were byte-identical after installation.
  The reopened app read the existing thread with both saved messages. No owner app or
  research project was replaced, restarted or edited. The old temporary fixture's data
  files were no longer present, so a fresh temporary sample/profile was created through
  the 0.6.5 app APIs before taking the baseline; this is not recovery of that old fixture.
- Test paths: `/private/tmp/hs-update-e2e-066` (profile, sample, hashes and logs),
  `/private/tmp/hs-update-e2e-061/old/HumanStudy Hub.app` (isolated upgraded executable),
  `/private/tmp/humanstudy-0.6.6-final` (verified installers and asset checksums).
- Tested normal quit/install plus manual reopening with isolated profile flags. The
  Restart action is covered in UI/controller tests; automatic native relaunch was not
  exercised here because it drops the fixture's custom profile flags.
- Production `/download` still returned cached 0.6.5 links immediately after publication;
  the public GitHub release and actual updater already served 0.6.6.

A same-version upgrade loop and all real-paper UI stalls remain unproven as general root
causes. The concrete eager PDF work and false-positive/hidden source behavior are fixed;
existing short stored evidence requires agent re-extraction rather than fabricated expansion.
