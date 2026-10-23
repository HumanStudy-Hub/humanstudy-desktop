# Research catalog and version-pinned community copies

Review branch: `codex/community-research-index`. Merge/release only after owner approval.

The library prefers Bench's `research_index.json`, falling back to its original numbered index
for backwards-compatible rollout. `HUMANSTUDY_COMMUNITY_BRANCH` selects the Bench review branch
for local testing. Search covers source metadata, substudy text and reviewed concept aliases;
lexical alias expansion does not silently assign a reviewed taxonomy label.

Desktop cards and detail pages show assigned topics from the same catalog. Clicking a topic
filters by its stable concept ID; typing its English or Chinese alias searches both assigned
papers and matching source text. These are intentionally different operations: a text hit does
not create a classification. The initial catalog contains only the framing seed, not automatic
classification of all 302 records. A domain curator still needs to lead taxonomy expansion.
Availability distinguishes indexed sources, legacy study materials and accepted Human Programs.
Cards are displayed 30 at a time; search always covers the entire cached catalog.

For a browser review of the actual desktop renderer with the public catalog:

```bash
mkdir -p app/src/renderer/public/preview
cp ../bench-research-index/co_website/data/research_index.json app/src/renderer/public/preview/research_index.json
cd app && npm run preview:web -- --host 127.0.0.1 --port 5184
# Open http://127.0.0.1:5184/?catalog=research and choose Studies.
```

This is a visual preview with a scripted agent, not an Electron release or a live contribution.
The public catalog fixture is ignored by Git; Electron uses the real shared index loader.

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
