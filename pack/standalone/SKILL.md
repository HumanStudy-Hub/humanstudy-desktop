---
name: humanstudy
description: Turn a social-science paper (PDF) into a HumanStudy program, a cited, reviewable record of who took part, what each group saw and did, what was measured and how it was analysed, plus a replay package that runs AI participants and the paper's own analysis. Use when asked to rebuild, check, replicate, pilot or simulate a published human study or experiment, or to package one as a skill for another agent. No app or account needed.
---

# HumanStudy: paper → program → runnable study

This is the HumanStudy Hub build pipeline without the desktop app. `$HS` below means the absolute
path of this skill's folder (the folder holding this SKILL.md). Scripts need Python 3.8+; PDF text
needs `pypdf` (`pip install pypdf`) or the `pdftotext` command.

Read [references/rules.md](references/rules.md) before writing anything. Those rules are the
scientific contract: every original participant is an AI participant, printed materials are copied
verbatim, and what the paper does not state is marked `missing` with an issue, never filled in.

## 1. Set up a project folder

One folder per paper, laid out as in [references/project-format.md](references/project-format.md):

```text
<project>/paper.pdf        the paper (read-only)
<project>/sources/         supplements or materials the researcher supplied (optional)
```

Work inside it. Scratch files go in `<project>/.humanstudy/tmp/`. The schema is
`$HS/schema/human-program.schema.json`; the checks find it themselves.

## 2. Build the program and the replay package

Follow [references/build.md](references/build.md) step by step. Short version:

```bash
python $HS/scripts/pdf_pages.py paper.pdf --from 1 --to 4       # page texts with page numbers
python $HS/scripts/build/program_io.py .humanstudy/tmp/batch-01.json   # save each checkpoint
python $HS/scripts/build/check_program.py program.json          # after every save, until PASS
python $HS/scripts/build/check_program.py program.json --complete
python $HS/scripts/build/check_quotes.py program.json           # every quote on its cited page
python $HS/scripts/build/check_package.py package/<paper-slug>  # the runnable package
```

Where build.md mentions the app's Study document or Simulation tab, show the researcher the file
or a short summary instead. Ask decisions as a short question with a few options and room for a
written answer; a dismissed question is not consent.

## 3. Run AI participants (only when the researcher asks)

Running is a separate decision from building. Confirm with the researcher which study, how many AI
participants per condition, and which model. Then, from the project folder:

```bash
python $HS/scripts/export/agent/study_core.py --root . run --n 5 --cli "claude -p --model haiku"
python $HS/scripts/export/agent/study_core.py --root . run --n 5 --cli "codex exec --skip-git-repo-check -s read-only -"
```

Each participant is a new CLI process that receives only its prompt, in an empty folder. Never
answer participant prompts yourself in this conversation: you know the hypothesis. Add
`--out artifacts/simulations/<date>.json` to keep the sessions. Report results as a simulation,
next to the paper's reported results; agreement does not show that people would behave the same way.

## 4. Share the study with other agents

```bash
python $HS/scripts/export/agent_package.py --output exports/<project>-agent-<date>
```

This writes a skill folder for this one study (readable references with pages, the program, the
package, an accuracy report) that anyone can install in Claude Code, Codex or OpenCode. Add `--mcp`
for clients that cannot run commands. The paper stays out unless the researcher has the right to
share it (`--include-paper`).

## Contributing back

Programs built here can be shared with the HumanStudy community at https://humanstudy-hub.com and
discussed at https://forum.humanstudy-hub.com.
