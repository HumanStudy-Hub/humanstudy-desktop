# Desktop simulation relay (draft)

This change is not ready for cross-platform release. Desktop relay simulations currently
require macOS `sandbox-exec`; Linux and Windows refuse these runs. A platform decision and
additional security review are required before merging or releasing this draft.

The main process creates one relay after the existing Simulation approval passes package
validation. The relay listens on a random IPv4 loopback port. Only the approved model and text
chat requests are accepted. A random per-run capability authenticates requests. The real hosted
or OpenRouter key stays in the app process; the kernel environment removes upstream credentials.
The kernel's own conversation transport remains a separate capability.

A run reserves at most 200,000 tokens and lasts at most 30 minutes. Each request reserves its
UTF-8 request bytes, 256 framing tokens per message, and an output limit of at most 4,096 tokens.
Reservations are conservative and never refunded. Usage logs contain model names and token
counts, never prompts or upstream credentials. The descriptor and usage log live in app-owned
storage outside the project. A final launcher completion, explicit Stop, or expiry revokes the
capability; ending a chat turn alone does not interrupt a background simulation.

`run_confined.py` starts the entire run script before any package imports. It passes capability
values in the compatibility key variables and relay addresses in `OPENROUTER_BASE_URL` and
`OPENAI_BASE_URL`. The package sees no real upstream credential. On macOS the sandbox allows
network connections only to the relay's localhost port, restricts file writes to the run folder,
and reads to package/source/program/skill inputs plus runtime libraries. Process-info access
is denied except for self. Sysctl reads are denied except hardware/OS names: process-info denial
alone does not stop `KERN_PROCARGS2`, and exact-name procargs filtering proved insufficient.

The coordinator agent is trusted to use these canonical entry points. Desktop `simkit` imports
and `study_core` package/human loaders refuse unconfined execution under the app marker;
`simkit start` automatically uses the trusted launcher. This does not sandbox the agent's
arbitrary shell tools or stop a deliberately bypassing coordinator from implementing another
runner. The kernel conversation capability must never be passed into package code. Claims of
isolation apply to canonical runs through the launcher, not arbitrary agent-authored execution.

Researchers invoking standalone `study_core.py` by hand retain the existing own-key CLI.
Tests use fake credentials and localhost stub providers; no paid provider calls are needed.
