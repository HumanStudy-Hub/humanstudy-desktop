# HumanStudy Desktop — "opencode for social scientists"

A Mac app (Electron + Vite + React + TypeScript) for social-science researchers. Left: chat with an
agent that streams every step. Right: artifacts (default **Protocol** document generated from the
Human Program; generated HTML views; exports). A PDF source drawer opens from any citation.

Style reference: DeepSeek Harness ("Explore the limits of intelligence") — clean, calm, generous
whitespace, light/dark, minimal chrome. Look it up for cues; do not copy assets or branding.

## Ownership (do not edit outside your area)
- `app/` (A): Electron main entry, preload, Vite renderer shell, layout, styles, package.json.
- `app/src/main/kernel/` (B): kernel bridge. Interface `Kernel` (startSession, send, abort, events)
  with an opencode implementation (`opencode serve`, HTTP + SSE `/event`, `POST /session/:id/prompt_async`,
  `POST /session/:id/abort`) and a mock implementation used when opencode is missing.
- `pack/` (C): the social-science layer: AGENTS.md + skills (build, visualize, analyze, export, refine),
  project folder format, Human Program contract. Kernel-agnostic.
- `app/src/renderer/program/` and `app/src/shared/` (D): Human Program types/validator and the
  Protocol document view ported from humanstudy-hub-web.

## Project folder format
~/HumanStudy/<project>/ — paper.pdf, sources/, program.json (Human Program v2), artifacts/*.html|png|md,
exports/, .humanstudy/session.json

## Scientific contract
Verbatim text is never rewritten; missing items are labelled missing; every claim cites evidence
(page + quote); conditions come only from condition nodes + conditionIds; arrows only from next edges.
