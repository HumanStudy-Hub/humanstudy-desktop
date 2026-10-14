# Native agent questions — 2026-10-13

The desktop bridges OpenCode question.asked/replied/rejected events and the native
GET /question, POST /question/:id/reply and POST /question/:id/reject APIs.
Requests are filtered to the active session before answers or dismissals are sent.

The existing left chat shows one question at a time, with radio/checkbox choices,
optional written answers, Back and explicit Continue. Nothing is preselected or
submitted automatically. Answering resumes the original tool call. Dismiss & stop
ends that turn (the behavior verified in the installed HumanStudy OpenCode 1.18.21).
Stopping also clears native pending requests: abort alone leaves them on that server.
Live pending questions are restored on thread activation; completed, lost or stopped
requests cannot be answered as though still live. Late/duplicate events update the
original card, including questions earlier in a long history.

Local thread files preserve complete question text/options and answers. With content
consent enabled, conversation.question records pending and resolved states, without
shortening research content. Usage-only question.reply/reject events contain ids and
counts, not answer text. The simulation scope approval remains a separate requirement.
The bundled build/simulate instructions ask only the next consequential decision and
retain original paper evidence separately from researcher choices.

Verification:
- TypeScript checks and desktop regression suite: 33 checks passed.
- question.test.mjs against the real installed OpenCode binary with a deterministic
  localhost model fixture: answer, dismiss, abort, resumed session, pending-list cleanup
  and exact answers reaching the model tool result passed. No hosted model quality
  or complete real-paper simulation is claimed by this fixture.
- UI preview checked: no implicit answer; default/custom exclusivity; multi-select;
  Back preserving selections; switching threads restores a pending question; submitting
  produces an answer record and continues the conversation.

The new arm64 dogfood DMG is locally signed, not notarized or publicly released.

The Haiku dogfood installer uses `anthropic/claude-haiku-5.5` for the desktop default,
kernel fallback and simulation helper fallback. Explicit model choices still override
defaults. The current owner's saved preference was also changed to Haiku. This package
continues to target the protected dev backend: the developer's Keychain bypass is not
bundled, and collaborator access must be verified before distribution.
