# Large source requests

The hosted desktop model gateway rejects requests above approximately 4 MB, and its
hosting ingress has a separate 4.5 MB limit. These are serialized HTTP byte limits,
not model output allowances or token context windows. The pinned OpenCode 1.19.0
classifies every HTTP 413 as context overflow, so ordinary automatic compaction is
not sufficient protection against repeated binary attachments.

The shared `OpencodeKernel` now puts an authenticated, per-project loopback adapter
between its hosted provider and the existing gateway. This applies to both desktop
and the headless asset worker, including Paper2Skill when run through that worker.
It does not change upstream Paper2Agent's default hosts, a separate personal
OpenCode installation, or the developer-only direct OpenRouter route.

## Behavior

- Requests that fit 3,600,000 UTF-8 bytes are forwarded unchanged.
- Oversized requests replace the oldest inline image/PDF attachments with explicit
  local file references until they fit. Complete original bytes are retained in
  `.humanstudy/tmp/request-archive/`, with content-derived names and private file
  permissions. Native conversation records and original paper files are unchanged.
- The newest visual evidence stays inline whenever it fits. A single oversized
  image may need to be rendered as smaller pages/crops before visual inspection;
  the reference explicitly says not to infer unseen details. PDFs can be read via
  complete page-marked text and rendered source pages.
- If attachments are insufficient, large older text tool results are retained in
  full local text files with read-back instructions. The latest tool result,
  user/assistant text, and tool call arguments/identities are not shortened.
- Failure to fit is explicit. Research content is not silently truncated, and
  user prompts or tool definitions are not removed to force a request through.
- An identified gateway body-size HTTP 413 permits one further reduction and
  retry, only if the outgoing body actually changes. Repeated body-size failures
  become a distinct terminal local error, avoiding the pinned kernel's blind
  context-overflow classification. Genuine context errors remain available to
  native compaction; rate limits preserve their status and retry header.
- Streaming uses backpressure; cancellation and kernel disposal close upstream
  requests and the local listener. Upstream credentials are kept in process memory;
  no request bodies, credentials, or source materials are written to diagnostics.

The archive is local working material, under the existing private `.humanstudy`
directory, not a new public artifact. Source/code export policies still apply.
This request adaptation does not prove that every source has been examined or
that a generated scientific asset is complete. Those need separate source-fidelity
and completion checks.

## Verification

Run from the repository root with installed app dependencies:

```sh
node app/src/main/kernel/request-transport.test.mjs
node app/src/main/kernel/kernel.test.mjs
node app/src/main/kernel/recovery.test.mjs
```

The native regression also requires explicit local fixtures:

```sh
HUMANSTUDY_KERNEL_BIN=/path/to/hs-v1.19.0/opencode \
HUMANSTUDY_TEST_PAGES=/path/to/23-page-images \
node app/src/main/kernel/request-transport.live.test.mjs
```

The native test uses an offline deterministic model named `transport-fixture`,
fake credentials and asserted loopback endpoints. It makes no paid model calls.
With 23 page images from the 1977 false-consensus paper, it completed 23 native
image reads and saved a fixture JSON checkpoint: 26 requests, maximum outgoing
body 3,592,024 bytes, complete native history 7,659,764 bytes, 13 exactly preserved
archived images. This checkpoint is a transport fixture, not a scientifically
validated Human Program or evidence of Haiku completing either conversion task.

Additional tests cover UTF-8 versus JS string length, original PDF preservation,
final text/evidence preservation, archive symlink rejection, bounded changed-body
retry, native context errors, 429 retry headers, authentication, streaming and
upstream cancellation. Both application TypeScript projects pass type checking.

The earlier paired conversion trial stopped near 32k cumulative output tokens
because of the evaluator's explicit 30k allowance with completed-message overshoot.
This patch neither raises that test allowance nor establishes a model output cap.
