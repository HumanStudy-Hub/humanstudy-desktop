# Onboarding polish (professors' pilot, 2026-11)

First use got stuck on three things. Design rule: no new buttons or tabs; the agent does the work, the UI
displays. Strings stay in `app/src/renderer/i18n-dict.ts` (English and Chinese); colours use the existing
tokens, so dark mode is unchanged.

## 1. Jargon hidden by default

**Before.** Under the composer the chat always showed `Auto on`, `Enter queues` / `Enter interrupts` and a
usage line such as `Haiku 5.5 · 107.8k in · 24.8k out`. The run confirmation (macOS relay) said
"through a limited model relay (up to 4,800,000 tokens and 20 minutes)", in Chinese "模型中转" and "词元",
both in the notice and again in the note under Run simulation.

**After.**
- Chat (`app/src/renderer/components/Chat.tsx`, `app/src/renderer/styles.css`, block after `.usage-line`):
  the auto-mode toggle and the Enter hint appear when the pointer is over the composer's bottom row or
  keyboard focus is inside it; the usage line appears on hover of that row or of the line itself, and it is
  now focusable (`tabIndex=0`, focus ring) so keyboard users reach it and its tooltip. The Enter hint is
  linked to the text box with `aria-describedby`, so screen readers still announce it. Reduced motion
  turns off the fade. The model picker stays visible.
- Run confirmation (`app/src/shared/package-readiness.ts` `runConfirmation`,
  `app/src/renderer/components/SimulationPanel.tsx`): with the relay, the visible text says only that the
  code runs on this computer and "at most N minutes" (`sim.run_notice_relay`, `sim.note`). The relay and its
  token cap moved to a native `<details>` disclosure, "Details" / "详情" (`sim.relay_detail`), keyboard
  operable. Without the relay (Linux, Windows) nothing is folded: `sim.note_key` (the study's code can read
  your API key) and `sim.run_notice` show as before; `runConfirmation` returns `detail: null` there, and
  `app/src/shared/package-readiness.test.mjs` asserts both.
- Not changed: the agent's own community-fork notice in `pack/skills/simulate/SKILL.md` ("Approval"), which
  must quote the relay limits exactly. It is a safety notice.

## 2. Home: one way in

**Before.** "Start a new project" showed three equal cards (From a paper, Blank project, Sample · Knobe
2003), next to the left Projects / Study library nav.

**After** (`app/src/renderer/components/Home.tsx`, `.start` block in `styles.css`). "From a paper" is one
full-width entry with a larger title. Below it, on one line: "+ Blank project" as a quiet text button (its
explanation is the tooltip; clicking still opens the inline name field) and the example as a small link,
"Or look at an example first: Knobe 2003" (`home.sample_link`, replacing `home.sample`). Same three actions,
no new controls; the left nav is unchanged. On narrow windows the entry stacks.

## 3. The agent speaks first

**Before.** After a build the report ended without a way forward, and the opened example had an empty chat:
the professor had to invent the first question.

**After.**
- `pack/AGENTS.md`, new section "Offer the next step": after a build, a simulation, a refinement or the
  example's first message, the agent ends with two or three lettered next steps the researcher can pick by
  replying "A"/"B" (see what participants see in a condition, run a small simulation, go through open item
  N). Letters, because the build report already numbers its questions. Only steps possible now; run times
  only as the Simulation tab states them; offering never authorizes a simulation.
- `pack/skills/build/SKILL.md`, "5. Report" item 6 **Next**, phrased as options so the report's
  "no other sentence ends with a question mark" rule still holds; `pack/skills/simulate/SKILL.md`, final
  reply.
- Example open: `app/src/renderer/App.tsx` sends `sample.intro_prompt` once, as the first message, when the
  example project created from Home opens and the agent is ready; `startIntro` in
  `app/src/renderer/useSession.ts` sends only if that conversation belongs to the project, is idle and
  has no messages. The prompt asks for a two-sentence introduction plus next steps and says not to change
  files or run anything. It appears in the chat as the researcher's message (as the automatic build prompt
  already does) and is logged as such. The welcome dialog (`SampleOnboarding.tsx`) is unchanged.
- `app/src/main/previous-pack-hashes.json` lists the v0.7.2 hashes of the three changed pack files, so
  existing projects with untouched copies receive the new instructions (`refreshPack`).

## Checks

`npm run typecheck`, `npm run build` and the `src/**/*.test.mjs` suites in `app/`.
