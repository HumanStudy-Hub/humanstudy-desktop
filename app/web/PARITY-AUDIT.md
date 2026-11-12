# Browser / Desktop parity audit — 2026-11-12

Baseline: Desktop dev `78a5a7c` (`app/package.json` 0.8.0). Remote main `e08aa5f`
and newest fetched tag `v0.8.0-beta.1`; installed `/Applications/HumanStudy Hub.app`
reports 0.8.0-beta.1. This audit does not establish the deployed `/try` image version.

The production browser bridge is `web/browser-electron.ts`, which compiles the real
preload against HTTP/SSE. `src/renderer/browser-api.ts` is a scripted visual preview,
not the deployed browser backend. The web backend loads the real main process.

| Capability | Finding and verification |
| --- | --- |
| PDF upload and attachments | Real uploads feed the same create/import handlers. Fixed unrelated uploads blocking every IPC, including Stop and answers. Browser regression tests cover dependent ordering, concurrent upload and failed-upload isolation. |
| Agent streaming, tools, questions, permissions | Same preload/main handlers over HTTP/SSE. Local server test exercises event delivery and reconnect replay; adapter test verifies Stop/question requests during upload. No paid/real-model turn tested. |
| Files, saves, annotations | Same read/write/version paths. Added real-server test for annotation round trip, stale-write rejection, export/download bytes and download path restriction. PDF visual highlighting was not manually exercised. |
| Simulation | Same readiness and runner code, but Linux browser sandbox uses the key route rather than the macOS relay. No real simulation or model call tested here. |
| Export and contribution | Save-copy/conversation/research-export handlers use browser downloads. Fixed silently blocked external-link popups by retaining a real clickable fallback link. Actual public submission not performed. |
| Persistence | Projects and conversations live outside the replaceable application folder. Local save persistence verified; Vercel sandbox stop/restore and production image rollout require launcher acceptance. |
| Research collection | Real collector is wired through shared preload/main. Server now sets trusted `HUMANSTUDY_RESEARCH_SURFACE=web`; shared collector implementation is a separate coordinated change. No live research records submitted. |

Intentional limits: no native folder picker, Finder, desktop menu or desktop updater.
The browser's session notice assumes the launcher's persistent sandbox contract; this audit
has not verified that infrastructure. Keep this distinction in release claims.

Verification: Electron main/renderer build and web build; web TypeScript check;
2 browser adapter regressions; 7 local real-main server tests with mock kernel.
Local server tests need localhost binding outside Codex's filesystem/network sandbox.
No production database writes, paid model usage, main merge, tag or deployment.
