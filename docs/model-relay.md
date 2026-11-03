# Desktop simulation relay

Which path a simulation takes depends on the computer. The main process decides once, at start:
the relay path needs macOS and the system `/usr/bin/sandbox-exec` (never one found on `PATH`).
Nothing in a project or a study package can change this choice.

| Platform | Model access | What the study's code can see |
|---|---|---|
| macOS | Per-run relay inside `sandbox-exec` | A per-run capability that works only for the approved model, only on the relay port, and only until the run ends. Never the real key. |
| Linux, Windows (and macOS without `/usr/bin/sandbox-exec`) | The pre-relay path | The signed-in key in its environment. No sandbox. |

## macOS: relay and sandbox

The main process creates one relay after the existing Simulation approval passes package
validation. The relay listens on a random IPv4 loopback port. Only the approved model and text
chat requests are accepted. A random per-run capability authenticates requests. The real hosted
or OpenRouter key stays in the app process; the kernel environment removes upstream credentials.
The kernel's own conversation transport remains a separate capability.

A run reserves at most 200,000 tokens and lasts at most 30 minutes. Each request reserves its
UTF-8 request bytes, 256 framing tokens per message, and an output limit of at most 4,096 tokens.
Reservations are conservative and never refunded. Usage logs contain model names and token
counts, never prompts or upstream credentials. The descriptor and usage log live in app-owned
storage outside the project. A successful final launcher run, explicit Stop, or expiry revokes the
capability. A failed run keeps it, within the same token and time limits, so the fixed script can
be started again. Ending a chat turn alone does not interrupt a background simulation.

`run_confined.py --no-model` runs model-free package code, such as `study_core.py reproduce`, in
the same sandbox with no network at all, no relay and no credential, writing only to a scratch
folder that is removed afterwards. The pinned human data are fetched first by
`study_core.py human-data`, which runs no package code.

`run_confined.py` starts the entire run script before any package imports. It passes capability
values in the compatibility key variables and relay addresses in `OPENROUTER_BASE_URL` and
`OPENAI_BASE_URL`. The package sees no real upstream credential. The run folder is the working
directory. The sandbox allows network connections only to the relay's localhost port, restricts
file writes to the run folder, and reads to the project folder and runtime libraries (the
project holds no credential; the relay descriptor and usage log live outside it). Process-info access is denied
except for self. Sysctl reads are denied except hardware/OS names: process-info denial alone does
not stop `KERN_PROCARGS2`, and exact-name procargs filtering proved insufficient.

The run confirmation says: "Model access is limited to 200,000 tokens and 30 minutes." A
community revision adds: "This study's code will run on your computer through a limited model
relay (up to 200,000 tokens and 30 minutes)."

## Linux and Windows: the pre-relay path

Neither platform has a sandbox here that can limit package code to one localhost port and hide
other processes' environments. So the relay is not used there, and simulations run as they did
before the relay existed. The app does not start a relay and does not set
`HUMANSTUDY_RELAY_REQUIRED`. `run_confined.py` (with or without `--final` or `--no-model`) then
runs the script directly, like `python run.py` in the run folder. The kernel environment keeps
the signed-in key (the hosted key, or `OPENROUTER_API_KEY` on the developer path), and
`humanstudy_llm` reads it from there.

Differences from before this change, none of which affect what package code can reach: runs
are started through `run_confined.py`; the app now always refreshes `simkit.py` and
`run_confined.py` in a project (a hand-edited `simkit.py` is replaced); `study_core.http_llm`
honours `OPENROUTER_BASE_URL`; and on the developer OpenRouter path the agent's own conversation
goes through the app's request transport instead of reading the key from its config.

What that means:

- Any code in the study package can read the key and send it anywhere, or use it without the
  relay's model, token or time limits.
- No network or file sandbox applies to the run.
- The relay's usage log is not written. `humanstudy_llm` still appends token counts to
  `.humanstudy/tmp/llm-usage.jsonl`, but package code can bypass it.

The existing run confirmation says this before Run: "On this computer, the study's code can read
your API key. Only run studies you trust." A community revision also shows "This study's code
will run on your computer with access to your model key." No new button or screen is added.
The renderer falls back to this wording whenever the main process does not report the relay.

## Trust boundary on every platform

The coordinator agent is trusted to use the canonical entry points. On macOS, desktop `simkit`
imports and `study_core` package/human loaders refuse unconfined execution under the app marker;
`simkit start` automatically uses the trusted launcher. This does not sandbox the agent's
arbitrary shell tools or stop a deliberately bypassing coordinator from implementing another
runner. The kernel conversation capability must never be passed into package code.
Claims of isolation apply to canonical macOS runs through the launcher.

Exported agent skills and the standalone `study_core.py` CLI run outside the app with the
researcher's own key on every platform, and print "This study's code will run on your computer
with access to your model key." before package code runs.

Tests use fake credentials and localhost stub providers; no paid provider calls are needed.
