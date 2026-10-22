# Initial conversion with Claude Code or Codex

Use your own Claude Code/Codex session to execute the same research pack used by
HumanStudy desktop. Electron, OpenCode, Hub model credentials and private GitHub
Actions jobs are not required. This is instruction-and-tool reuse, not a remote
conversion API or a deterministic model runner.

## Prepare a project

Use the review branch until the owner approves its merge:

```sh
git clone --branch codex/community-research-index https://github.com/HumanStudy-Hub/humanstudy-desktop.git
cd humanstudy-desktop
python3 scripts/prepare_conversion.py \
  --project ../conversions/example-paper \
  --paper /path/to/paper.pdf \
  --resource /path/to/source-materials.zip \
  --resource /path/to/existing-digital-resources
```

`--paper` is optional: a case may consist entirely of existing digital resources.
Repeat `--resource` for additional files or directories. The output directory must
be new; existing projects are never overwritten. ZIPs are copied intact, not
automatically extracted. Private application folders and environment files are
excluded from directory copies; symlink inputs are rejected.

The helper copies the current `pack/` schema, skills, checkers and artifact kit
unchanged, retaining their existing `.opencode/` paths for compatibility. These
paths do not imply that OpenCode is required. `AGENTS.md` sets initial-conversion
scope, `CLAUDE.md` points to it, and `CONVERT.md` contains the task. A private local
pack hash manifest identifies exactly which tools/instructions were installed.
Preparation does not read credentials, call models, execute research code, publish
assets or certify a scientific result.

## Run in your existing agent

Open the generated project directory in Claude Code or Codex. Ask:

> Read AGENTS.md and CONVERT.md and perform the initial conversion using the shared
> build skill. Preserve missing items and save all outputs. Do not run simulations.

Use your own approved model/account and normal permission controls. No service key
from the Hub is needed. This is a user-started coding-agent task, not an unattended
batch executor. To work through a collection, have the agent prepare one project
per case and process them in rolling batches, keeping a tracker and continuing
past recorded failures. Do not automatically retry failed cases indefinitely.

The desktop's managed Python environment is not bundled by this helper. Prepare
a local environment once, or use an existing verified environment:

```sh
python3 -m venv ../conversion-runtime
../conversion-runtime/bin/python -m pip install jsonschema pypdf
../conversion-runtime/bin/python -m pip freeze > ../conversion-runtime/requirements-resolved.txt
```

Use the equivalent `Scripts/python.exe` path on Windows. Point the coding agent at
this environment. `pypdf` can extract PDF text page by page; it does not provide OCR.
The full scientific/simulation runtime is unnecessary for initial conversion.

From the generated project, use that environment's Python to run:

```sh
python -c 'import jsonschema'
python .opencode/skills/build/check_program.py program.json
python .opencode/artifact-kit/inline.py artifacts/study-overview.html
```

Replace `python` with the prepared environment's interpreter. The first command
matters: the shared checker skips JSON Schema validation when `jsonschema` is
absent. Preserve actual check results and missing issues; do not confuse technical
validity with source verification or successful scientific reproduction.

## Outputs and review

Keep `program.json`, permitted resources under `sources/`, generated `artifacts/`
and `artifacts/conversion-report.md`. The source-supported identity/title and
overview summary/abstract use the existing schema; do not introduce another
metadata format. Do not invent absent facts. Runnable packages, simulation,
taxonomy and exhaustive manual scientific auditing are outside this initial pass.

The generated project can later be opened in HumanStudy desktop. HTML artifacts
are self-contained after inlining; source-navigation messages need the desktop
host to open the corresponding paper/attachment. Plain browser viewing is not a
test of that host integration.

For export, follow `.opencode/skills/export/SKILL.md`. Exclude private `.humanstudy/`
state, chat and credentials; only redistribute resources with permission. Owner
approval remains required before merge or publication.

## Maintenance

There is no fork of the scientific build prompt, schema, validator or kit. New
projects use the pack from the checked-out repository version. Existing prepared
projects remain pinned to their copied pack; prepare a new project for a different
version rather than silently overwriting outputs or customized instructions.

Regression checks (Python with `jsonschema` installed):

```sh
python -m unittest discover -s scripts/tests -p 'test_prepare_conversion.py' -v
```

The checks exercise preparation, pack parity, native program validation and input
safety. They do not make a paid Claude Code/Codex generation call or establish
equivalent model behavior across harnesses.

Project-instruction references: [OpenAI Codex guidance](https://developers.openai.com/cookbook/examples/codex/iterating-development-workflows-with-codex)
and [Claude Code project instructions](https://code.claude.com/docs/en/memory).
