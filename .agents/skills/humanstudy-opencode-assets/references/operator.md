# Operator reference

## Repository and prerequisites

The implementation review branch is `codex/opencode-asset-skill` in
`HumanStudy-Hub/humanstudy-desktop`. It is based on the coordinated
`codex/community-research-index` branch. It must not be merged before owner review.
Open this checkout in Codex so its repository-scoped `.agents/skills` is available.
See [Codex skill discovery](https://learn.chatgpt.com/docs/build-skills).

Install Node dependencies once with a recent supported Node (22 or newer):

```sh
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --prefix app
```

Use the HumanStudy OpenCode release matching `KERNEL_TAG`/`KERNEL_VERSION` in
`app/src/main/opencode-install-core.ts`, not a random system `opencode`. The current
tag is `hs-v1.19.0`. Download the correct platform archive from the
[official project release](https://github.com/HumanStudy-Hub/opencode/releases/tag/hs-v1.19.0),
verify its checksum against that release's `SHA256SUMS.txt`, and extract it. An
explicit path to an already installed matching binary also works; do not modify
an installed desktop application or use its live kernel session.

Provide a matching managed research runtime `bin` path, or install one through the
existing desktop installer code:

```sh
node app/scripts/install-runtime.mjs /path/to/asset-runtime
```

This uses the desktop interpreter, pinned dependencies and PDF shims. Current
managed-runtime targets are macOS arm64/x64 and Windows x64; an unsupported target
must be reported instead of claiming desktop runtime parity. Use `Scripts`/`.cmd`
and environment assignment conventions appropriate to Windows.

Model access is explicit. For the owner's issued Hub access, use the authorized
`HUMANSTUDY_DESKTOP_KEY` environment variable and `--provider humanstudy`. Do not
retrieve somebody else's key or copy the desktop keychain. For a user's own
OpenRouter account, set `OPENROUTER_API_KEY` and `HUMANSTUDY_DEV_KEYS=1` in their
environment and use `--provider openrouter --model <available-model-id>`. Never put
key values in CLI arguments, source files, transcripts or PRs. A Codex subscription
does not by itself authorize or configure OpenCode model calls.

## Prepare and start

```sh
python3 scripts/prepare_conversion.py \
  --engine opencode \
  --project /path/to/conversions/source-case-id \
  --paper /path/to/paper.pdf \
  --resource /path/to/materials.zip \
  --resource /path/to/digital-resources
```

The paper is optional and resources are repeatable. This copies the original
desktop `AGENTS.md`, complete pack, schema, validators and kit. Preparation does
not generate an asset, call a model or extract the ZIP.

```sh
node app/scripts/opencode-assets.mjs \
  --project /path/to/conversions/source-case-id \
  --binary /path/to/opencode \
  --runtime-bin /path/to/asset-runtime/bin \
  --provider openrouter --model <available-model-id> --doctor
```

After compatibility succeeds, remove `--doctor` and start the bridge in an
interactive terminal (`exec_command` with `tty: true` in Codex). Keep stdin open;
use `write_stdin` to send JSON lines and read the emitted events. Do not pipe a
single build line and close stdin: EOF stops the worker rather than orphaning it.
The server binds to loopback with generated basic authentication through desktop's
own kernel code. Personal OpenCode config and sessions are isolated by that code.

Default Auto is on, just as desktop. `--auto off` requests explicit permission
decisions. The same project heuristic is reused, not replaced with allow-all.
Never approve every pending request merely because it came from the worker.

Timeout defaults are 30 minutes per turn and 5 minutes without text/successful
tool progress; `--timeout-minutes` and `--stall-minutes` are configurable. Pending
permissions/questions pause the no-progress check, but not the total deadline.
Do not launch two workers in the same project; a private lock prevents two bridge
instances. It does not coordinate with a separately opened desktop session.

## Control protocol

Wait for `{"type":"ready",...}`. Every command can include an `id` for its reply.
Send JSON through stdin, not shell interpolation:

```json
{"op":"build","id":"initial"}
{"op":"native","operation":"context","id":"context"}
{"op":"native","operation":"todos","id":"todos"}
{"op":"permission","permissionId":"per_example","reply":"once"}
{"op":"permission","permissionId":"per_example","reply":"reject"}
{"op":"questions"}
{"op":"answer","questionId":"q_example","answers":[["A supplied, authorized answer"]]}
{"op":"reject-question","questionId":"q_example"}
{"op":"auto","mode":"off"}
{"op":"abort"}
{"op":"native","operation":"compact"}
{"op":"send","text":"The checker reports unknown evidence ID ev-4. Inspect the saved program, repair that reference from the supplied source, preserve its missing items and re-run validation."}
{"op":"quit"}
```

These are examples, not a sequence to run blindly. Replace pending IDs with the
actual event IDs. Answer a scientific choice only from the user's instructions or
provided facts. Otherwise reject/defer it, wait for the turn to stop, and instruct
the worker to retain the missing issue. No remembered `always` grants are exposed.

Read operations include status/context/todos/history/changes/catalog/models/tools/
skills/commands/agents/providers/session. Idle-session controls include compact,
select, fork, undo and redo. A fork changes the bridge's selected session ID.
Account administration, sharing, arbitrary HTTP access and production publishing
are intentionally outside this asset-generation bridge.

`event` lines identify a private full-event log and its line number. Text is also
written completely to `assistant.txt`. Large scientific outputs are not truncated;
read the referenced file when needed. Native operation replies retain full data.
`done` is turn completion only; validation is the supervisor's next step.

Logs and per-run provenance/results stay under `.humanstudy/asset-agent/`. Deadline,
stall, EOF and signals stop the owned server, preserve files and produce an
explicit outcome. Resume a persisted session with `--session <actual-id>` using
the same project; an unknown ID fails rather than silently creating a new one.
If a crash leaves `running.lock`, verify that its recorded process and owned
server have stopped before removing that lock. Never kill a process by name.

## Validate and export

Use the managed runtime's `python` to run the generated project's shared
`check_program.py`. Run `artifact-kit/inline.py` for each applicable HTML artifact.
Require schema-valid initial outputs, not scientific completeness: missing issues
are allowed and must stay attached. Artifact abstracts/overview summaries must
come from the current program fields, not a new parallel metadata schema.

Export from the generated project:

```sh
python .opencode/skills/export/community.py --output exports/community.zip
```

Use `--include-paper` only with redistribution authorization. Preserve source
identities from an actual catalog record/fork in `.humanstudy/community.json` when
available; record a real baseline only when the project was copied from it. Never
invent a current revision to make a merge pass. The exporter excludes private
local state and puts minimal contribution metadata in `CONTRIBUTION.json`.

## Data PR

The skill lives in the desktop implementation repository; converted research data
belongs in the target Bench repository, not in the desktop application source.
Create a separate data branch from the agreed review baseline (currently Bench
`codex/community-research-index`; use updated main after its approval/merge).

For a batch PR, stage standard exported assets under:

```text
imports/initial/<batch-id>/tracker.csv
imports/initial/<batch-id>/<case-id>/CONTRIBUTION.json
imports/initial/<batch-id>/<case-id>/program.json
imports/initial/<batch-id>/<case-id>/sources/...
imports/initial/<batch-id>/<case-id>/artifacts/...
```

This is a review staging area, not an accepted recommendation or an automatically
published catalog entry. Do not fabricate trusted review attestations or edit
`community/*/current.json`/generated indexes to publish it. Maintainer review and
promotion into the shared catalog remain separate from this conversion task.

Stage only explicit exported files after inspecting paths and redistribution
terms. Keep large restricted datasets as references with retrieval instructions.
The tracker distinguishes failures/access blocks from converted assets and lists
the known missing items. No taxonomy work is required.

When authorized to submit, inspect `git diff --cached`, commit, push the data
branch, then `gh pr create --draft --base <agreed-base> --body-file <file>`.
Describe this as initial conversion with missing information, identify the pack/
kernel/model used, include checks actually run, and link Bench issue #28. Never
claim a live-model build when only fixtures ran. Do not merge. In Codex desktop,
attach every created PR with the available pull-request artifact tool.
