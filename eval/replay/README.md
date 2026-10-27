# Replay against human data

Checks the two things a simulation sandbox needs before anyone uses it:

1. **Does our analysis match the paper?** The package's own `evaluate()` runs on the original human
   data. Its key effects should come out close to what the paper reports. If they do not, the
   extraction (materials, coding, exclusions or analysis) is wrong, and no simulation is needed to
   see it.
2. **Do AI participants match the humans?** The same package runs with AI participants, and each key
   effect is compared with the human one: same direction, and same significance where both have a
   p-value.

```bash
# one paper, step by step
python eval/replay/attach_human.py <project> --data <data file or folder> [--data <codebook>]
python eval/replay/compare.py <project> --n 10          # Claude Haiku participants by default

# many papers, end to end (build -> human data -> replay -> community export), resumable
python eval/replay/pilot.py pilots.json --work runs/pilots --jobs 3
```

`attach_human.py` asks one agent session (instructions in `HUMAN_DATA.md`) to write
`package/<slug>/human/human_sessions.py`: `load(data_dir)` returns sessions in exactly the shape the
package's `run_sessions` returns, and `key_effects(evaluation)` lists the paper's key tests with a
signed estimate, a p-value and the reported value. The script then checks the loader itself: the
sessions load, have the right shape, the package's analysis runs on them and key effects come back.

`compare.py` writes `replay-compare.json` and `.md` in the project. `pilot.py` also copies them to
`artifacts/replay/` so the community export carries them, and links the project to its catalog entry
(`.humanstudy/community.json`) so the contribution attaches to the right paper.

The default participant command is a fresh `claude -p --model haiku` process per participant with no
tools, settings or MCP servers. Claude Code still adds a short environment note (platform, date), so
use it for testing; formal runs should use the app's model API or `study_core.http_llm`.

Human data never goes into the repository. Keep it with the project, outside version control.
