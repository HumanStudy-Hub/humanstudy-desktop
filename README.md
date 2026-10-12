# HumanStudy Desktop

Open-source desktop app for social scientists: turn a published human study into a
reviewable, replicable Human Program with an agent, and check every claim against the
original paper.

- **Three panes**, each foldable: the study agent, the original paper, and the Human
  Program (a readable protocol plus generated artifacts).
- **Projects** live as plain folders in `~/Documents/HumanStudy Projects`.
- **Studies**: a community library backed by
  [HumanStudy-Bench](https://github.com/HumanStudy-Hub/HumanStudy-Bench); fork a study into
  a local project.
- **Kernel-agnostic**: the agent runs on [opencode](https://opencode.ai) today; the
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

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
