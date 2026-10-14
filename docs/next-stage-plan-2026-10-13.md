# Next stage: researcher dogfood

Use the existing editor and left agent conversation. Default model remains Haiku 5.5.
The three priorities from the owner’s 2026-10-13 feedback are implemented locally and
must remain release acceptance checks:

1. **Source comparison (P0 regression).** Human Program and its cited original source
   stay visible together. Citation clicks open the source beside the extraction,
   not replace it. One Compare source toggle; draggable/keyboard-resizable divider;
   saved per-project layout. Clear citation focus when switching projects. Paper tab returns to the main paper when another resource
   is selected. Both visible views and source focus accompany messages to the agent.
2. **Auto on by default, explicit on/off.** One switch in the chat and the same setting
   in Settings. Changes affect existing sessions, including an eligible pending tool
   request when Auto is enabled. Auto grants each matching project action once;
   switching off must not leave native “always allow” grants created by Auto.
   Researcher questions, acceptance of design changes, and simulation-scope approval
   remain explicit. This is the existing project permission policy, not an OS sandbox.
3. **Researcher-facing activity.** A compact activity line describes observed research
   work: reading the paper, reviewing study design/evidence, checking readiness,
   preparing replication materials, running an approved simulation. General thinking
   stages derive from visible activity; do not fabricate progress, findings or expose
   hidden reasoning. Commands, tool identifiers and complete input/output remain in
   expandable technical details and research records.

## Still to validate or implement before broader sharing

- [ ] Fix and verify hosted Haiku reasoning/output budget behavior before sharing.
      Owner dogfood on Oct 13 returned two completed `finish: length` messages,
      each with 32,000 reasoning tokens and zero visible output or tool calls.
      The hosted proxy forwards the request unchanged; the kernel caps output at
      32,000. Budget exhaustion is confirmed; why the model uses the entire budget
      still needs a real hosted-model validation. Owner authorized adjusted automatic
      recovery: after native idle, lower reasoning effort for the recovery request,
      inspect saved checkpoints and complete smaller units without dropping detail.
      At most two adjusted attempts per user request; the second requires visible
      output or a successful tool action during the first. A repeated zero-output
      failure stops with an explicit error. Cancellation, duplicate idle events and
      native continuation must not trigger extra requests. Partial output, files and
      all token usage remain intact. Verified with installed OpenCode and a localhost
      model fixture, including `reasoning_effort: low` in the outgoing request.
      This change is local until the owner installs the recovery dogfood build.
- [ ] Owner dogfood on a real modern human-only paper: extract → inspect source
      comparison → resolve Need input through native questions → review a proposed
      refinement → confirm scope → run and export. Save concrete failure cases.
- [ ] PDF text layer: exact quote highlighting, zoom and text selection/annotation;
      connect selected paper passages to the left agent. Canvas-only page navigation
      and the exact quote card are available now; inline PDF highlighting is not done.
- [ ] Resolve sample auxiliary-source references: the browser sample cites vignette
      JSON resources that are not included in its preview file tree. Do not silently
      substitute the main PDF when the cited attachment is unavailable.
- [ ] Verify collaborator sign-in, invitation and access to the protected dev backend.
      The developer’s Keychain bypass is not included in installers. Locate the locally
      stored invitation code; `local-test-code` in a local fixture is not a verified
      dev invitation. No production deploy or public release until owner’s test.

## Acceptance evidence for this stage

- TypeScript checks and targeted renderer/history regressions.
- Real installed OpenCode with a localhost deterministic model: Auto on → off →
  repeated action asks → Auto on resumes the pending action. Only one-call approvals.
- UI preview: source comparison renders the real PDF beside the program, pointer and
  keyboard resizing work, closing/reopening works, citations preserve the program,
  and Auto toggles visibly. A missing auxiliary source is labelled unavailable.
- A local Mac arm64 dogfood installer is built after these checks; signed, not notarized.

Regression suite: 34 checks passed. The subsequent activity classifier refinement
passed targeted researcher-UX checks; the project-switch citation reset passed
TypeScript checks. Different-paper switching remains part of real-paper dogfood.

Recovery follow-up: 36 regression checks passed; native length → adjusted request →
visible response passed using installed OpenCode and a localhost model fixture.
Additional stop-during-dispatch checks passed. Recovery attempts emit consent-gated
`agent.recovery` usage events with attempt, reason, strategy, model and effort.
The original task is retained; the internal adjustment prompt is also stored in
OpenCode's native session history. No hosted-model request or owner-session retry
was performed during these checks. The recovery installer supersedes the stage2
installer and still requires owner installation and real-paper validation.
