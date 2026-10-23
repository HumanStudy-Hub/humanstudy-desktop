# HumanStudy Hub · desktop app

Open-source desktop app for social scientists: turn a published human study into a
reviewable, replicable Human Program with an agent, and check every claim against the
original paper.

- **Three panes**, each foldable: the study agent, the original paper, and the Human
  Program (a readable protocol plus generated artifacts).
- **Projects** live as plain folders in `~/Documents/HumanStudy Projects`.
- **Studies**: a community library backed by
  [HumanStudy-Bench](https://github.com/HumanStudy-Hub/HumanStudy-Bench); fork a study into
  a local project.
- **Kernel-agnostic**: the agent runs on the HumanStudy edition of [opencode](https://github.com/HumanStudy-Hub/opencode) today; the
  social-science layer in [`pack/`](pack/) (AGENTS.md and skills) works with any
  AGENTS.md-aware harness.

Status: early development. See [SPEC.md](SPEC.md).

## Develop

```sh
cd app
npm install
npm run dev           # Electron
npm run preview:web   # renderer in a browser with a scripted agent
npm run typecheck
npm run dist:mac      # signed macOS build (needs a Developer ID certificate)
```

## Generate assets without the desktop UI

Open this checkout in Codex and use
[`$humanstudy-opencode-assets`](.agents/skills/humanstudy-opencode-assets/SKILL.md).
Codex supervises the actual desktop OpenCode kernel and shared research pack to
convert source bundles, retain missing information, and prepare a draft data PR.
See the skill's [operator reference](.agents/skills/humanstudy-opencode-assets/references/operator.md)
for explicit model access, matching kernel/runtime setup and the control protocol.
No desktop GUI or account-key copying is required. Publication still needs review.

## Dogfooding against the dev preview

Nothing to install: on first run the app downloads its agent kernel, the HumanStudy edition of
opencode, from the [HumanStudy-Hub/opencode releases](https://github.com/HumanStudy-Hub/opencode/releases)
(pinned to one tag, verified against the release's `SHA256SUMS.txt`) into its own data folder. The
app never uses an opencode installed on your machine, and the kernel keeps its config, sessions and
caches under the app's data folder (`kernel/`), so a personal opencode setup is untouched. For
development, `HUMANSTUDY_KERNEL_BIN=<path>` runs a locally built kernel and `HUMANSTUDY_KERNEL=mock`
uses the built-in mock agent.

The `dev` branch of the website deploys to a protected Vercel preview. `npm run dev:dogfood`
points the app at it and sends the deployment-protection bypass secret, which it reads from the
macOS Keychain item `humanstudy-dev-bypass` (ask a maintainer for it; it is never committed). Use
the dev promo code to unlock hosted models there.

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
