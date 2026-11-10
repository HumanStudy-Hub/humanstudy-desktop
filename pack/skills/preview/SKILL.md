---
name: preview
description: Show the study's protocol.json as participants saw it, screen by screen per arm, as one offline HTML artifact (artifacts/preview.html) with provenance marks (reported/derived/missing). Use when the researcher asks to see the screens, what a participant sees, or what differs between arms.
---

# preview: the participant view of protocol.json

```bash
python .opencode/skills/preview/make_preview.py --out artifacts/preview.html --lang <uiLanguage> [--arms a b]
```

Pass `--lang` the `uiLanguage` from the workspace context (en or zh-CN): the page's own words follow it, and the
participant's screens keep the protocol's language. It plays a few sessions per arm with the engine (no model calls) and prints `PASS <file>` or `FAIL` with the
problems; fix nothing in protocol.json to make it pass, report the findings it prints instead (an arm with no
session, a session that did not complete). The page opens as an artifact card in the app.

How to read it (tell the researcher): plain text is verbatim from the administered material; blue marks
reported/derived text and amber marks missing text (hover for the source); grey notes are about the page, not on
it. It shows one played session per arm, so piped values and random orders are one draw. The Conditions tab is
for operators: it names conditions participants never saw.

The page contains the protocol's screen text: keep it in the project; never publish, upload or attach it.
`build_preview.py`, `preview.css` and `preview.js` are vendored from the sandbox; `make_preview.py` is the app's.
