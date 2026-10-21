# Research catalog and version-pinned community copies

Review branch: `codex/community-research-index`. Merge/release only after owner approval.

The library prefers Bench's `research_index.json`, falling back to its original numbered index
for backwards-compatible rollout. `HUMANSTUDY_COMMUNITY_BRANCH` selects the Bench review branch
for local testing. Search covers source metadata, substudy text and reviewed concept aliases;
lexical alias expansion does not silently assign a reviewed taxonomy label.

Accepted community copies download from one exact Git commit. Their manifest identity, each
file's hash and its byte length are checked before creating the local project. Full programs,
packages, sources and research artifacts are retained. `sources/study.json` records the stable
paper ID and actual `baseRevision`; exports preserve them for three-way contribution merging.
This replaces the old behavior of recording a commit while downloading mutable `main` files.

The new `catalog` skill queries the shared search API. Broad results can be saved completely
inside the project instead of producing giant tool responses. It is available in existing
projects after pack refresh, without overwriting customized files.

The export skill's `community.py` creates a proposal ZIP from program/package/artifacts/sources,
excluding chat, credentials and local state. PDFs require explicit redistribution permission.
The web contribution form reads the paper metadata from that ZIP; users need no GitHub account
or version selection. Public-source access and validation gaps remain explicit.

Scientific content is not capped at 500 KB or 1200 graph connections. Schema collection/text
caps and the artifact citation's 500-character slice were removed; large content stays complete.
Depth/identity/reference validation still applies. Large materials may remain referenced files.

Verification includes schema/checker parity with a >500 KB material, pinning/tampering tests,
pack-refresh regressions, both TypeScript configurations and an Electron production build.
This branch does not publish a desktop release or activate the community maintainer.
