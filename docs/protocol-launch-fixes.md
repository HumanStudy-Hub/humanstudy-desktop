# Protocol launch fixes

The app accepts a verified community revision containing `protocol.json` without requiring an old
`program.json`. Its source commit, revision manifest, byte counts and file hashes are verified before
files are imported. The protocol release allowlist mirrors `hsenv.release.PUBLIC_PATHS`; private sources,
conversation/app state and run records are refused. After import the received protocol and its held-text
list are pinned in app storage. Concurrent imports serialize writes to the shared pin store.

A protocol that needs a different engine remains previewable, but the readiness gate refuses its
simulation with an update explanation. Engine range syntax supports the documented comma-separated
comparisons (`>=0.8,<0.9`); unrecognized syntax fails closed.

## Draft completion is separate from simulation readiness

For an automatic build that writes `protocol.json`, the app checks the saved bytes itself with its
bundled schema and static reference validator. New drafts require schema version 1, paper title/source
information, a participant flow for runnable arms, and reasons for blocked arms. Explicitly missing
materials do not prevent a structurally valid draft from finishing. The certificate is bound to the
file bytes; a change during validation or a later edit invalidates it. A reopened project's persisted
completion status is independently checked once per file version in the new app process.

This certifies a draft's structure, not extraction completeness, source fidelity or an independent
scientific review. Simulation still requires the existing full source/mechanical checks, original-wording
restoration and approval/budget gates. No new fallback bypasses those gates. Existing program/package
builds retain their validation path.

Protocols with all arms blocked remain previewable; their missing-material reasons are shown, with no
model budget or simulation offered. The existing Ask agent action requests a plain-language explanation
and, when appropriate, a draft email to the paper's authors. The app never sends that email. No source
wording is invented to unblock a run.

## Models and first use

An automatic build or an explicit Build study action uses Sonnet as its per-turn hosted default, including automatic recovery. Ordinary
chat returns to Haiku, and an explicit model selection remains authoritative. The model selection is
not changed permanently. Provider configuration exposes recovery controls for both defaults.

The existing skippable guide is shown in the first workspace rather than only the sample. It has three
steps and waits until the research consent dialog is dismissed. Existing completed-guide preferences
are retained.

Simulation confirmation and research-data wording distinguish local original-file storage and research
capture filtering from study text being sent to the selected model provider. Technical check-name
prefixes are removed from the missing-material list; underlying reasons remain intact.

## Scope and validation

This change does not restart any batch, call a paid model, change the extraction pipeline, modify a
study's scientific content, apply database migrations, or publish the new library assets. In particular,
updating the build skill to produce the new protocol as its default deliverable remains separate work.

Validation uses invented fixtures: legacy and protocol imports, tampered files/private paths, concurrent
pins, draft completion/restart/forged state, stale checks, blocked arms, engine requirements and model
routing/recovery. Run the offline CI suite (excluding `*.live.test.mjs` and `native-live.test.mjs`),
TypeScript checks, the production bundle and `web/web.test.mjs` against the built web edition. A real
hosted-paper build and real Windows-machine user acceptance are separate checks; offline tests do not
substitute for them.
