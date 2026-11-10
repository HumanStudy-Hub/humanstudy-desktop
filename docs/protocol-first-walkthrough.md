# Protocol-first walkthrough and stable release gate

New desktop and online-IDE projects use protocol.json. The example is a normal editable project, not a mock
screen or an agent conversation that has to build something first. Nothing in this change launches a paid model,
publishes new community studies, applies a database migration or silently converts a researcher's legacy project.

## Shipped example

Mazzarella et al. (2018), *Believing what you're told: Politeness and scalar inferences*. Both studies, the
unchanged CC BY paper, source text and the existing independent fidelity review are included. The old Knobe
example is not installed by new desktop or web builds: its actual question wording is incomplete and the prior
sample's questions must not be promoted as verbatim. Existing user projects are retained.

App packaging changes only the protocol version/title/source path. Experiment text, flow, assignment, coding,
exclusions and analysis are preserved from the reviewed conversion. The sample README states every known
omission, derived rule and unsupported analysis. The study card uses the schema's canonical JSON hash; preview
identity and app approval use raw-file bytes. These hashes deliberately serve different contracts.

## Verified walkthrough

1. Create the sample without an account or an agent turn: a scholarly program, protocol, paper and a current preview are installed;
   no legacy execution package, automatic build or fake AI result is created.
2. Study opens on the research overview. Expand the participant preview to traverse pages and compare conditions; these are seeded examples,
   not all possible sessions or a claim that missing consent/timing information has been recovered.
3. Click a participant passage: source comparison stays in Study, opens the correct paper page and carries
   the complete passage. Preview notes/quotes and bridge payloads are not clipped. Frames stay sandboxed with
   no network access. A stale or malformed preview cannot stand in for an edited protocol.
4. Simulation reads the protocol route, including when an older program also exists. The existing scientific,
   original-wording, model-access, cost and user-approval gates remain authoritative.
5. The app's trusted runner completed both studies and produced a results page using a localhost test responder
   (two sessions per study). This is an integration test, not a model/human comparison; test outputs are not
   shipped as example results. It found and fixed a report crash on valid lists/maps of result citations.
6. App and agent protocol saves share a lock. Stale checkpoint hashes refuse to overwrite researcher edits;
   local history includes protocol/study files. Protocol versions enter the existing consent/owner/privacy-gated
   artifact capture path. No new collection category or database permission is introduced.

## New project defaults and legacy compatibility

The automatic prompt, researcher rules, build/refine and query/view/export guidance now select protocol.
The old build procedure is in build/LEGACY.md and used only for legacy maintenance. Untouched shipped prompts
upgrade by their recorded hashes; custom project instructions are preserved. New protocol checkpoints include
all empirical studies, including blocked arms with their reasons, and use explicit expected hashes.

This is app-side default routing, not a redesign or re-evaluation of Claude's extraction pipeline. The separately
distributed standalone skill and old web Studio builder remain legacy integrations. They must not be described
as protocol-native or silently used as substitutes for the online IDE. Generic MCP export for protocol is also
not implemented here; export guidance explicitly refuses to claim that an ordinary bundle is an MCP server.

## Before promoting stable

- [x] Sample protocol schema, card hash and full engine/source checks pass.
- [x] Real browser: sample opens without a build, participant pages render, condition comparison works, citation
      click opens Paper beside Study at page 5. Desktop-width screenshot retained in the local acceptance log.
- [x] Trusted execution with local test responses finishes both studies and writes a non-official report.
- [x] Model defaults from the parent PR remain Sonnet for builds, Haiku for chat; manual choice wins.
- [ ] Real hosted Sonnet build from a fresh PDF produces the protocol/preview, with honest missing items. This
      belongs to extraction acceptance with Claude; offline checks do not prove a prompt is followed by a model.
- [ ] Packaged Mac first-run and beta-to-stable upgrade click-through with preserved projects/chats.
- [ ] Physical Windows acceptance; Windows CI is separate and must pass on the final commit.
- [ ] Production online IDE bundle promotion and version verification.
- [ ] Resolve the public entry-point policy for legacy web Studio and the standalone skill before advertising
      every surface as protocol-native. No scientific-content bulk migration is authorized by these app changes.
- [ ] Independent review before merge/promotion; publish a beta for acceptance before a stable tag.

## Theme and local disk follow-up

Dark surfaces are neutral charcoal instead of forest green; the app, new participant previews and the artifact
kit retain a restrained moss accent. Existing user-authored HTML is not silently rewritten. The app-owned preview
wrapper adds palette.css without modifying the vendored preview code or experimental wording. Browser computed
backgrounds matched rgb(32, 33, 36) in the shell and the new sample's iframe.

Local generated old installers/unpacked apps and inactive .next caches were removed after checking they contain
no tracked files and no running apps/dev servers. About 3.8 GiB was removed; free disk rose from 2.9 to ~8.1 GiB
(observed filesystem capacity also reflects other system activity). No installed user app, projects, chats,
research sources, dependencies or uncommitted source trees were deleted. A local cleanup manifest is retained
outside Git. RELEASING.md records retention guidance so old generated distributions do not accumulate.

### Website palette alignment

Following Astra's design review, new/missing settings default to Light to match the current website's Folio Moss palette (web app/globals.css). Previously saved Light/Dark/System preferences remain unchanged. Secondary text now uses the exact website #5e6e60 value. Embedded frames inherit the host colour scheme, including OS-dark browser/light-app cases; the terminal reads live app tokens rather than a hard-coded forest-green background. Existing user-authored artifacts may implement their own explicit theme controls.

## Paired research pilots

The public build skill now distinguishes initial complete research understanding from preparing a requested experimental scope. `program.json` is a scholarly-v1 profile of Human Program v2, with original-source evidence, a version pin, study/arm mappings and result references. It does not duplicate executable steps. The trusted draft gate checks paired files and the current preview; legacy protocol-only projects remain readable. A valid draft is not run approval.

Mazzarella adds a curated research draft for both studies; its previously reviewed protocol bytes are unchanged. The existing engine supports categorical outcomes but not paper reaction-time analyses. Browser verification opened the source beside Study and loaded the participant view. The trusted runner completed both studies, and in a separate test completed only the requested Study 1, using a localhost test responder. Research hypotheses did not enter participant requests.

Knobe is a local-only pilot built from the existing sandbox protocol. It retains both experiments and their reported results in the research document. Missing administered questions/response labels keep both original experiments blocked. The browser exposed the targeted material review action and no valid run. No replacement wording or variant was accepted or run. Copyrighted PDF, protocol materials and local quotes are not shipped or committed.

The preparation action prefills the existing agent composer, rather than starting a run. Guest UI verification covered the switch to the agent panel, not a hosted model conversation. On-demand preparation instructions, machine checks, local UI and the local runner are verified; live fresh-PDF generation, a real clarification/material handoff, a user-approved variant run, automatic preview regeneration and private intake/handback integration are not yet accepted. No batch work resumed, paid call, merge or release.

Verification: typecheck, production desktop/web build, 103 targeted app/IPC/runner/checkpoint tests, and both browser walkthroughs.
