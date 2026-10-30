#!/usr/bin/env python3
"""Export the study as an agent package: a skill folder and an MCP server, both built from program.json.

    python .opencode/skills/export/agent_package.py --output exports/<project>-agent-<date>

The skill follows Paper2Agent's paper skill (github.com/jmiao24/Paper2Agent, MIT): any agent that
reads SKILL.md folders can read, query and run the study. `--mcp` adds an MCP server over the same
folder for clients that cannot run commands. Before the folder appears it is verified: file hashes,
every study renders, the scripts run, real MCP calls (with --mcp), and the package smoke test; every
quote is also compared with its cited page (references/accuracy.md).
The paper PDF and sources/ stay out unless the researcher has the right to share them.
"""
import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "agent"))
from study_core import Study  # noqa: E402

VERSION = "humanstudy-agent-package/1"
SKIP = {"__pycache__", ".pytest_cache", ".DS_Store", ".env", ".git", ".humanstudy", "node_modules"}


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def skill_name(program):
    raw = (program.get("id") or program.get("title") or "study").lower()
    name = re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", raw)).strip("-")[:64].strip("-")
    return name or "study"


def paper_path(root, study):
    """The project's paper: paper.pdf by the project format, else the file the program names."""
    named = study.program.get("source", {}).get("filename")
    for candidate in ["paper.pdf", named]:
        path = (root / candidate).resolve() if candidate else None
        if path and path.parent == root.resolve() and path.is_file():  # never a file outside the project
            return path
    return root / "paper.pdf"


def copy_tree(src, dest):
    shutil.copytree(src, dest, ignore=lambda d, names: [n for n in names if n in SKIP or n.endswith(".pyc")
                                                       or n.startswith(".env")])


def file_id(value):
    """A study id as a file name that is valid on every platform (ids may contain ':')."""
    return re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip(".-") or "study"


def year_of(study):
    src = study.program.get("source", {})
    if src.get("year"):
        return str(src["year"])
    for n in study.nodes:
        for f in n.get("fields", []) if n.get("kind") == "overview" else []:
            if f.get("id") == "year":
                m = re.search(r"\b(1[89]\d\d|20\d\d)\b", str(f.get("value")))
                if m:
                    return m.group(1)
    m = re.search(r"\((1[89]\d\d|20\d\d)\)", str(src.get("venue", "")))
    return m.group(1) if m else ""


def citation(study):
    src = study.program.get("source", {})
    authors = src.get("authors")
    if isinstance(authors, list):
        authors = ", ".join(a if isinstance(a, str) else a.get("name", "") for a in authors)
    year = year_of(study)
    head = " ".join(p for p in [authors or "", "(%s)" % year if year else ""] if p)
    parts = [head, study.program.get("title"), src.get("venue"),
             "https://doi.org/" + src["doi"] if src.get("doi") else None]
    return ". ".join(p.rstrip(".") for p in parts if p) + "."


def short_authors(study):
    authors = study.program.get("source", {}).get("authors") or ""
    names = authors if isinstance(authors, list) else re.split(r",\s*|\s+and\s+|;\s*", authors)
    names = [n if isinstance(n, str) else n.get("name", "") for n in names if n]
    last = [n.split()[-1] for n in names if n.split()]
    if not last:
        return ""
    return last[0] if len(last) == 1 else "%s and %s" % (last[0], last[1]) if len(last) == 2 else last[0] + " et al."


def readiness_text(study):
    r = study.readiness()
    if not study.package:
        return "Reading only: no replay package was built, so AI participants cannot be run yet."
    if r.get("status") == "ready":
        return ("Ready to run the parts the replay package covers (see `package/%s/task/task.json`). "
                "Results from AI participants are a simulation, not observations of people." % study.package.name)
    blocking = ", ".join(r.get("blocking") or []) or "see open-issues.md"
    return "Not ready to run: the study still needs decisions (%s). Reading and querying work." % blocking


def skill_md(study, name, quote_line=None):
    ov = study.overview()
    who = short_authors(study)
    year = year_of(study)
    label = ("%s (%s)" % (who, year) if who and year else who or year or "").strip()
    description = ("%s%s: %d stud%s as a HumanStudy program, with participants, design, conditions, "
                   "verbatim materials, procedure, analysis, reported results and open issues, each cited "
                   "to its page. Use when asked about this study, to brief or run AI participants in it, or "
                   "to compare agent answers with the reported human results."
                   % (label + " " if label else "", ov["title"], len(ov["studies"]),
                      "y" if len(ov["studies"]) == 1 else "ies"))[:1024]
    rows = []
    for s in ov["studies"]:
        conds = ", ".join("`%s`" % c["id"] for c in study.conditions(s["id"])) or "none recorded"
        rows.append("| `%s` | %s | [study-%s.md](references/study-%s.md) | %s |" % (s["id"], s["title"], file_id(s["id"]), file_id(s["id"]), conds))
    pkg = study.package.name if study.package else None
    run = [
        "## Run AI participants", "",
        readiness_text(study), "",
    ]
    if pkg:
        run += [
            "The replay package `package/%s/` holds the participant prompts (`task/adapter.py`) and the "
            "paper's analysis (`evaluation/evaluation.py`)." % pkg, "",
            "Each AI participant must answer in its own fresh context that sees only its prompt. Never "
            "answer several prompts yourself in this conversation: you know the hypothesis, so those "
            "answers would not be independent participants.", "",
            "With an agent CLI you are signed in to (no key needed), one new process per participant:", "",
            "```bash",
            'python scripts/study_core.py run --n 5 --cli "claude -p --model haiku"',
            'python scripts/study_core.py run --n 5 --cli "codex exec --skip-git-repo-check -s read-only -"',
            "```", "",
            "Each process gets only the prompt on stdin, in an empty folder, so it cannot read this study. "
            "With an API key instead: `--model <model-id>` (`OPENROUTER_API_KEY`, or `OPENAI_API_KEY` with "
            "`OPENAI_BASE_URL`). To collect answers some other way: `plan --n 5` lists every prompt, and "
            "`replay replies.json --n 5` scores the replies given in the same order.", "",
        ]
        if (study.package / "human/key.json").is_file():
            run += [
                "## Human data", "",
                "The original human data are not in this folder. `python scripts/study_core.py human-data` "
                "downloads them from their source and checks every file against its pinned SHA-256. "
                "`python scripts/study_core.py reproduce` recomputes the paper's key results from them with "
                "the package's analysis: trust the analysis on AI participants only as far as it recovers "
                "the paper here. If the data are a replication sample, say so when you report.", "",
            ]
    if study.effects:
        n_eff = len(study.effects.get("effects") or [])
        n_hyp = len(study.effects.get("hypotheses") or [])
        run += [
            "## Effects", "",
            "`effects.json` links the paper's %d hypothes%s to %d effect%s: outcome, contrast (treatment minus "
            "reference), predicted direction, the paper's reported numbers (each quoted, with its page) and how "
            "each is computed from sessions. `python scripts/study_core.py effects` lists them (filter with "
            "`--hypothesis`, `--phenomenon`, `--topic` or `--role`). Every run and every reproduction returns "
            "one result block per effect in the same shape (cells, test, metric), for human and AI-participant "
            "sessions alike." % (n_hyp, "is" if n_hyp == 1 else "es", n_eff, "" if n_eff == 1 else "s"), "",
        ]
    return "\n".join([
        "---",
        "name: %s" % name,
        "description: %s" % json.dumps(description, ensure_ascii=False),
        "---", "",
        "# %s" % ov["title"], "",
        citation(study), "",
        "This folder is the study rebuilt as a program: what each participant saw and did, in order, and "
        "how the paper analysed it. Every fact comes from the paper and carries its page. "
        "`program.json` is the full machine-readable version.", "",
        "## Studies", "",
        "| Study | Title | Read | Conditions |",
        "| --- | --- | --- | --- |",
        *rows, "",
        "Also: [paper.md](references/paper.md) (background, findings, limitations), "
        "[open-issues.md](references/open-issues.md) (what the paper does not state) and "
        "[sources.md](references/sources.md) (source files and hashes) and "
        "[accuracy.md](references/accuracy.md) (%s) and "
        "[capabilities.md](references/capabilities.md) (what can and cannot be done with this study, and why)."
        % (quote_line or "what has been checked"), "",
        "Search everything: `python scripts/study_core.py search <words>`.", "",
        *run,
        "## Rules", "",
        "- Answer only from these files and cite the page given. If something is not here, say so.",
        "- Materials marked verbatim are shown to participants exactly as written. Never paraphrase them.",
        "- Items that read \"Not stated in the paper\" and open issues stay open: ask the researcher; "
        "never fill them with plausible text.",
        "- Results from AI participants are a simulation. They are not observations of people.",
        "- Do only what capabilities.md allows. A refused request (status `refused`) is reported with its "
        "reason; never replace it with an approximation of your own.",
        "",
    ])


def capabilities_md(study, failures):
    caps = study.capabilities()
    out = ["# Capabilities", "", "What this study can do, each with its reason. A tool refuses anything else "
           "(`status: refused`, with the reason and what to do instead).", "",
           "| Capability | Status | Why |", "| --- | --- | --- |"]
    names = [("read", "Read and search"), ("run", "Run AI participants"), ("humanData", "Human data"),
             ("authorCode", "Authors' analysis code"), ("profiles", "Participant profiles")]
    for key, label in names:
        part = caps.get(key)
        if isinstance(part, dict):
            out.append("| %s | %s | %s |" % (label, part.get("status"), (part.get("reason") or "").replace("|", "/")))
    rep = caps.get("reproduced") or {}
    if rep:
        out.append("| Paper reproduced from human data | %s | %s |" % (rep.get("package") or "not checked", rep.get("detail") or ""))
    excluded = (caps.get("run") or {}).get("excluded") or []
    if excluded:
        out += ["", "## Not runnable", ""] + ["- **%s**: %s" % (x.get("what"), x.get("reason")) for x in excluded]
    missing = (caps.get("humanData") or {}).get("missing") or []
    if missing:
        out += ["", "## Not in the human data", ""] + ["- **%s**: %s" % (x.get("what"), x.get("reason")) for x in missing]
    if failures:
        out += ["", "## Where the template does not fit", "",
                "| Pattern | Where | What | Fallback |", "| --- | --- | --- | --- |"]
        out += ["| %s | %s | %s | %s |" % tuple((f.get(k) or "").replace("|", "/") for k in ("pattern", "where", "what", "fallback"))
                for f in failures]
    if caps.get("note"):
        out += ["", caps["note"]]
    return "\n".join(out) + "\n"


def sources_md(study, root, include_paper, include_sources):
    out = ["# Sources", "", citation(study), "",
           "SHA-256 of the files this program was built from. Compare with your own copy.", "",
           "| File | SHA-256 | In this folder |", "| --- | --- | --- |"]
    paper = paper_path(root, study)
    if paper.is_file():
        out.append("| `%s` | `%s` | %s |" % (paper.name, sha(paper), "yes" if include_paper else "no"))
    if (root / "sources").is_dir():
        for f in sorted(p for p in (root / "sources").rglob("*") if p.is_file() and p.name not in SKIP):
            out.append("| `%s` | `%s` | %s |" % (f.relative_to(root).as_posix(), sha(f), "yes" if include_sources else "no"))
    return "\n".join(out) + "\n"


def readme(study, name, with_mcp):
    server = "%s/scripts/mcp_server.py" % name
    lines = [
        "# %s: agent skill" % study.program.get("title"), "",
        citation(study), "",
        "Built with HumanStudy Hub. `%s/` is a skill folder: `SKILL.md`, one readable reference per study "
        "with page numbers, `program.json` and the replay package. Any agent that reads skills can use it; "
        "it needs only Python 3.8+ (no packages, no keys)." % name, "",
        readiness_text(study), "",
        "On Windows use `python` or `py` where these lines say `python3`.", "",
        "## Install", "",
        "```bash",
        "# Claude Code",
        "mkdir -p ~/.claude/skills && cp -R %s ~/.claude/skills/" % name,
        "# Codex",
        "mkdir -p ~/.agents/skills && cp -R %s ~/.agents/skills/" % name,
        "# OpenCode: copy it into your project's .opencode/skills/",
        "```", "",
    ]
    if with_mcp:
        lines += [
            "## MCP server (optional)", "",
            "For clients that cannot run commands or read files. It serves the same folder:", "",
            "```bash",
            "claude mcp add %s -- python3 \"$PWD/%s\"" % (name, server),
            "codex mcp add %s -- python3 \"$PWD/%s\"" % (name, server),
            "```", "",
            "OpenCode `opencode.json`:", "",
            "```json",
            json.dumps({"mcp": {name: {"type": "local", "command": ["python3", "/absolute/path/" + server],
                                       "enabled": True}}}, indent=2),
            "```", "",
        ]
    lines += ["## Without an agent", "", "```bash", "python3 %s/scripts/study_core.py overview" % name, "```", "",
              "`MANIFEST.json` lists every file with its SHA-256. AI participants' answers are a simulation, "
              "not data from people.", ""]
    return "\n".join(lines)


def quote_report(root):
    """check_quotes.py from the build skill: every quote compared with the text of its cited page."""
    sys.path.insert(0, str(HERE.parent / "build"))
    try:
        import check_quotes
    except ImportError:
        return None, None
    report = check_quotes.check(root / "program.json")
    return report, check_quotes.summary(report)


def accuracy_md(report, line):
    out = ["# Accuracy checks", "",
           "What has been checked mechanically, independent of the model that built the program.", ""]
    if report is None:
        return "\n".join(out + ["The quote check was not available when this was exported.", ""])
    out += ["## Quotes against their pages", "", line + ".", "",
            "- **found**: the quote is on the cited page.",
            "- **close**: nearly verbatim (OCR noise or a small slip); reread before relying on it.",
            "- **other page** / **not found**: the quote or its page number needs fixing.",
            "- **unchecked**: no text layer on that page (scanned image) or not a PDF; check by eye.", ""]
    rows = [r for r in report["results"] if r["status"] != "found"]
    if rows:
        out += ["| Evidence | Page | Result | Detail |", "| --- | --- | --- | --- |"]
        for r in rows:
            detail = r.get("reason") or ("found on p. %s" % r["foundOn"] if r.get("foundOn") else
                                         "similarity %s" % r.get("similarity"))
            out.append("| `%s` | %s | %s | %s |" % (r["id"], r["page"], r["status"].replace("_", " "), detail))
        out.append("")
    out += ["Not checked mechanically: whether every study, condition and step of the paper is in the "
            "program, and whether fields that summarise rather than quote are right. Those rest on the "
            "researcher's review of the program.", ""]
    return "\n".join(out)


def build(root, out, include_paper=False, include_sources=False, with_mcp=False):
    study = Study(root)
    name = skill_name(study.program)
    skill = out / name
    skill.mkdir(parents=True)
    shutil.copy2(root / "program.json", skill / "program.json")
    if study.package:
        copy_tree(study.package, skill / "package" / study.package.name)
    if include_paper:
        paper = paper_path(root, study)
        if paper.is_file():
            shutil.copy2(paper, skill / paper.name)
    if include_sources and (root / "sources").is_dir():
        copy_tree(root / "sources", skill / "sources")
    (skill / "scripts").mkdir()
    shutil.copy2(HERE / "agent/study_core.py", skill / "scripts/study_core.py")
    shutil.copy2(HERE / "agent/effects_core.py", skill / "scripts/effects_core.py")
    if with_mcp:
        shutil.copy2(HERE / "agent/mcp_server.py", skill / "scripts/mcp_server.py")
    report, line = quote_report(root)
    refs = skill / "references"
    refs.mkdir()
    (skill / "SKILL.md").write_text(skill_md(study, name, line), encoding="utf-8")
    (refs / "paper.md").write_text("# Paper context\n\n" + study.paper_markdown(), encoding="utf-8")
    for s in study.studies:
        (refs / ("study-%s.md" % file_id(s["id"]))).write_text(study.study_markdown(s["id"]), encoding="utf-8")
    issues = study.open_issues()
    (refs / "open-issues.md").write_text(
        "# Open issues\n\nWhat the paper does not state or what still needs a decision.\n\n"
        + ("\n".join(study.issue_line(i) for i in issues) if issues else "None recorded.") + "\n", encoding="utf-8")
    (refs / "sources.md").write_text(sources_md(study, root, include_paper, include_sources), encoding="utf-8")
    (refs / "accuracy.md").write_text(accuracy_md(report, line), encoding="utf-8")
    if (root / "capabilities.json").is_file():
        shutil.copy2(root / "capabilities.json", skill / "capabilities.json")
    if (root / "effects.json").is_file():
        shutil.copy2(root / "effects.json", skill / "effects.json")
    try:
        failures = json.loads((root / "artifacts/failures.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        failures = []
    (refs / "capabilities.md").write_text(capabilities_md(study, failures if isinstance(failures, list) else []),
                                          encoding="utf-8")
    (out / "README.md").write_text(readme(study, name, with_mcp), encoding="utf-8")

    files = {p.relative_to(out).as_posix(): sha(p) for p in sorted(out.rglob("*")) if p.is_file()}
    paper = paper_path(root, study)
    manifest = {"format": VERSION, "created": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "programId": study.program.get("id"), "programSha256": sha(root / "program.json"),
                "paperSha256": sha(paper) if paper.is_file() else None,
                "readiness": study.readiness(), "capabilities": study.capabilities(), "skill": name,
                "mcpServer": name + "/scripts/mcp_server.py" if with_mcp else None,
                "quoteCheck": report["counts"] if report else None,
                "files": files}
    (out / "MANIFEST.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return name


def mcp_session(server, calls):
    """Start the server, initialize, run calls; return the responses by id."""
    msgs = [{"jsonrpc": "2.0", "id": 0, "method": "initialize",
             "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "verify", "version": "1"}}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}]
    msgs += [{"jsonrpc": "2.0", "id": i + 2, "method": "tools/call", "params": {"name": n, "arguments": a}}
             for i, (n, a) in enumerate(calls)]
    run = subprocess.run([sys.executable, str(server)], input="\n".join(json.dumps(m) for m in msgs) + "\n",
                         capture_output=True, text=True, encoding="utf-8", timeout=120,
                         cwd=str(Path(tempfile.gettempdir())))
    responses = {}
    for line in run.stdout.splitlines():
        try:
            msg = json.loads(line)
        except ValueError:
            raise AssertionError("MCP server wrote a non-JSON line to stdout: %r" % line[:200])
        responses[msg.get("id")] = msg
    return responses, run.stderr


def verify(out, name):
    checks = []
    manifest = json.loads((out / "MANIFEST.json").read_text(encoding="utf-8"))
    for rel, digest in manifest["files"].items():
        assert sha(out / rel) == digest, "hash mismatch: " + rel
    listed = set(manifest["files"]) | {"MANIFEST.json"}
    extra = [p.relative_to(out).as_posix() for p in out.rglob("*") if p.is_file()]
    assert set(extra) == listed, "unlisted files: %s" % sorted(set(extra) - listed)
    checks.append("files and hashes (%d files)" % len(manifest["files"]))

    skill = out / name
    text = (skill / "SKILL.md").read_text(encoding="utf-8")
    assert text.startswith("---\nname: %s\ndescription: " % name), "SKILL.md frontmatter"
    for link in re.findall(r"\]\(([^)#]+)\)", text):
        assert (skill / link).is_file(), "broken link in SKILL.md: " + link
    s = Study(skill)
    for st in s.studies:
        assert s.study_markdown(st["id"]).strip(), "empty study " + st["id"]
    missing = [e for n in s.nodes for f in n.get("fields", []) for e in f.get("evidenceIds", []) if e not in s.evidence]
    assert not missing, "fields cite unknown evidence: %s" % sorted(set(missing))[:5]
    checks.append("program loads and every study renders")
    cli = subprocess.run([sys.executable, str(skill / "scripts/study_core.py"), "overview"],
                         capture_output=True, text=True, encoding="utf-8", timeout=120, cwd=str(tempfile.gettempdir()))
    assert cli.returncode == 0 and json.loads(cli.stdout).get("id") == s.program.get("id"), "study_core.py: " + cli.stderr[-500:]
    checks.append("scripts/study_core.py runs from outside the folder")
    if (skill / "effects.json").is_file():
        sys.path.insert(0, str(skill / "scripts"))
        import effects_core
        problems, _ = effects_core.check(skill)
        assert not problems, "effects.json: %s" % problems[:5]
        checks.append("effects.json: hypotheses, effects and quoted numbers check")

    if manifest.get("mcpServer"):
        calls = [("study_overview", {}), ("capabilities", {})]
        if s.studies:
            calls.append(("read_study", {"study_id": s.studies[0]["id"]}))
        calls.append(("search_study", {"query": (s.program.get("title") or "study").split()[0]}))
        responses, stderr = mcp_session(out / manifest["mcpServer"], calls)
        assert responses.get(0, {}).get("result", {}).get("capabilities", {}).get("tools") is not None, \
            "MCP initialize failed: %s" % stderr[-500:]
        tools = [t["name"] for t in responses.get(1, {}).get("result", {}).get("tools", [])]
        assert {"read_study", "score_replies", "capabilities", "list_effects"} <= set(tools), "MCP tools/list: %s" % tools
        for i, (tool, _) in enumerate(calls):
            res = responses.get(i + 2, {}).get("result", {})
            assert res and not res.get("isError"), "MCP %s failed: %s %s" % (tool, res, stderr[-500:])
        checks.append("MCP server: initialize, %d tools listed, %d tool calls" % (len(tools), len(calls)))

    if s.package:
        with tempfile.TemporaryDirectory() as tmp:
            pkg = Path(tmp) / s.package.name  # a copy: files the test writes never reach the export
            shutil.copytree(s.package, pkg)
            run = subprocess.run([sys.executable, str(pkg / "task/adapter.py"), "--smoke-test"],
                                 capture_output=True, text=True, encoding="utf-8", errors="replace",
                                 timeout=300, cwd=str(pkg))
        assert run.returncode == 0, "replay package smoke test failed:\n%s%s" % (run.stdout[-800:], run.stderr[-800:])
        checks.append("replay package smoke test")
    return checks


def inside(path, folder):
    try:
        path.relative_to(folder)
        return True
    except ValueError:
        return False


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--output", required=True, help="new folder inside the project, e.g. exports/<project>-agent-<date>")
    ap.add_argument("--root", default=".", help="the research project (default: current folder)")
    ap.add_argument("--mcp", action="store_true", help="also add an MCP server, for clients that cannot run commands")
    ap.add_argument("--include-paper", action="store_true", help="copy the paper PDF (only with the right to share it)")
    ap.add_argument("--include-sources", action="store_true", help="copy sources/ (only with the right to share them)")
    a = ap.parse_args(argv)
    root = Path(a.root).resolve()
    out = (root / a.output).resolve() if not Path(a.output).is_absolute() else Path(a.output).resolve()
    if out.exists():
        print("error: %s already exists; choose a new name" % out, file=sys.stderr)
        return 1
    if not (root / "program.json").is_file():
        print("error: no program.json in %s; build the study first" % root, file=sys.stderr)
        return 1
    if a.include_sources and inside(out, (root / "sources").resolve()):
        print("error: choose an output folder outside sources/", file=sys.stderr)
        return 1
    out.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".agent-package-", dir=str(out.parent)))
    work = staging / out.name
    try:
        work.mkdir()
        name = build(root, work, a.include_paper, a.include_sources, a.mcp)
        checks = verify(work, name)
        quotes = json.loads((work / "MANIFEST.json").read_text(encoding="utf-8")).get("quoteCheck")
        work.rename(out)
    except (AssertionError, OSError, RuntimeError, KeyError) as exc:
        print("FAIL %s" % exc, file=sys.stderr)
        return 2
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    for c in checks:
        print("ok   " + c)
    if quotes is not None:
        bad = quotes.get("not_found", 0) + quotes.get("other_page", 0)
        print("%s quotes: %s" % ("note" if bad else "ok  ", ", ".join("%d %s" % (v, k.replace("_", " "))
                                                                     for k, v in sorted(quotes.items()))))
    size = sum(p.stat().st_size for p in out.rglob("*") if p.is_file())
    print("PASS %s (%.1f KB): skill %s%s" % (out, size / 1024, name, " with MCP server" if a.mcp else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
