#!/usr/bin/env python3
"""Export the study as an agent package: a skill folder and an MCP server, both built from program.json.

    python .opencode/skills/export/agent_package.py --output exports/<project>-agent-<date>

The layout follows Paper2Agent's combined delivery (skill/ + mcp/, github.com/jmiao24/Paper2Agent,
MIT): any agent that reads SKILL.md folders or speaks MCP can then read, query and run the study.
Both parts are generated from the same program and replay package and are verified before the
folder appears: file hashes, every study renders, real MCP calls, and the package smoke test.
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


def skill_md(study, name):
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
            "With your own model (no key needed here):", "",
            "1. `python scripts/study_core.py plan --n 5 > plan.json` lists every prompt, n per condition.",
            "2. Answer each prompt in a fresh context that sees only that prompt, with no other instructions: "
            "one AI participant per original participant.",
            "3. Save the replies as a JSON list in plan order and run "
            "`python scripts/study_core.py replay replies.json --n 5` for the paper's own analysis.", "",
            "Or let the package call a model directly: "
            "`python scripts/study_core.py run --model <model-id> --n 5` (needs `OPENROUTER_API_KEY`, or "
            "`OPENAI_API_KEY` with `OPENAI_BASE_URL`).", "",
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
        "[sources.md](references/sources.md) (source files and hashes).", "",
        "Search everything: `python scripts/study_core.py search <words>`.", "",
        *run,
        "## Rules", "",
        "- Answer only from these files and cite the page given. If something is not here, say so.",
        "- Materials marked verbatim are shown to participants exactly as written. Never paraphrase them.",
        "- Items that read \"Not stated in the paper\" and open issues stay open: ask the researcher; "
        "never fill them with plausible text.",
        "- Results from AI participants are a simulation. They are not observations of people.",
        "",
    ])


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


def readme(study, name):
    skill = "skill/%s" % name
    server = "mcp/%s-mcp/server.py" % name
    return "\n".join([
        "# %s: agent package" % study.program.get("title"), "",
        citation(study), "",
        "Built with HumanStudy Hub. The same program in two forms for AI agents:", "",
        "- `%s/`: a skill folder (`SKILL.md`, readable references, `program.json`, the replay package)." % skill,
        "- `mcp/%s-mcp/`: an MCP server with tools to read, search, prompt and score the study." % name, "",
        readiness_text(study), "",
        "Both need only Python 3.8+ (no packages). On Windows use `python` or `py` where these lines say "
        "`python3`, and absolute paths.", "",
        "## Claude Code", "",
        "```bash",
        "mkdir -p ~/.claude/skills && cp -R %s ~/.claude/skills/" % skill,
        "claude mcp add %s -- python3 \"$PWD/%s\"" % (name, server),
        "```", "",
        "## Codex", "",
        "```bash",
        "mkdir -p ~/.agents/skills && cp -R %s ~/.agents/skills/" % skill,
        "codex mcp add %s -- python3 \"$PWD/%s\"" % (name, server),
        "```", "",
        "## OpenCode", "",
        "Copy `%s` into your project's `.opencode/skills/` folder and add to `opencode.json`:" % skill, "",
        "```json",
        json.dumps({"mcp": {name: {"type": "local", "command": ["python3", "/absolute/path/" + server], "enabled": True}}}, indent=2),
        "```", "",
        "## Without an agent", "",
        "```bash",
        "python3 %s/scripts/study_core.py overview" % skill,
        "```", "",
        "`MANIFEST.json` lists every file with its SHA-256. AI participants' answers are a simulation, "
        "not data from people.", "",
    ])


def mcp_readme(study, tools):
    lines = "\n".join("- `%s`: %s" % (t["name"], t["description"]) for t in tools)
    return "\n".join(["# %s: MCP server" % study.program.get("title"), "",
                      "`python3 server.py` speaks MCP over stdio. It needs no packages and no keys.", "",
                      "## Tools", "", lines, "", readiness_text(study), ""])


def write_study_folder(study, root, dest, name, include_paper, include_sources):
    """Shared content of the skill and the MCP folders: program, package, optional sources."""
    dest.mkdir(parents=True)
    shutil.copy2(root / "program.json", dest / "program.json")
    if study.package:
        copy_tree(study.package, dest / "package" / study.package.name)
    if include_paper:
        paper = paper_path(root, study)
        if paper.is_file():
            shutil.copy2(paper, dest / paper.name)
    if include_sources and (root / "sources").is_dir():
        copy_tree(root / "sources", dest / "sources")


def build(root, out, include_paper=False, include_sources=False):
    study = Study(root)
    name = skill_name(study.program)
    skill = out / "skill" / name
    write_study_folder(study, root, skill, name, include_paper, include_sources)
    (skill / "scripts").mkdir()
    shutil.copy2(HERE / "agent/study_core.py", skill / "scripts/study_core.py")
    refs = skill / "references"
    refs.mkdir()
    (skill / "SKILL.md").write_text(skill_md(study, name), encoding="utf-8")
    (refs / "paper.md").write_text("# Paper context\n\n" + study.paper_markdown(), encoding="utf-8")
    for s in study.studies:
        (refs / ("study-%s.md" % file_id(s["id"]))).write_text(study.study_markdown(s["id"]), encoding="utf-8")
    issues = study.open_issues()
    (refs / "open-issues.md").write_text(
        "# Open issues\n\nWhat the paper does not state or what still needs a decision.\n\n"
        + ("\n".join(study.issue_line(i) for i in issues) if issues else "None recorded.") + "\n", encoding="utf-8")
    (refs / "sources.md").write_text(sources_md(study, root, include_paper, include_sources), encoding="utf-8")

    mcp = out / "mcp" / ("%s-mcp" % name)
    write_study_folder(study, root, mcp, name, include_paper, include_sources)
    shutil.copy2(HERE / "agent/study_core.py", mcp / "study_core.py")
    shutil.copy2(HERE / "agent/mcp_server.py", mcp / "server.py")
    listed, stderr = mcp_session(mcp / "server.py", [])
    tools = listed.get(1, {}).get("result", {}).get("tools")
    assert tools, "the MCP server did not start: %s" % stderr[-800:]
    (mcp / "README.md").write_text(mcp_readme(study, tools), encoding="utf-8")
    (out / "README.md").write_text(readme(study, name), encoding="utf-8")

    files = {p.relative_to(out).as_posix(): sha(p) for p in sorted(out.rglob("*")) if p.is_file()}
    paper = paper_path(root, study)
    manifest = {"format": VERSION, "created": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "programId": study.program.get("id"), "programSha256": sha(root / "program.json"),
                "paperSha256": sha(paper) if paper.is_file() else None,
                "readiness": study.readiness(), "skill": "skill/" + name, "mcp": "mcp/%s-mcp" % name,
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

    skill = out / "skill" / name
    text = (skill / "SKILL.md").read_text(encoding="utf-8")
    assert text.startswith("---\nname: %s\ndescription: " % name), "SKILL.md frontmatter"
    for link in re.findall(r"\]\(([^)#]+)\)", text):
        assert (skill / link).is_file(), "broken link in SKILL.md: " + link
    copies = {}
    for folder in [skill, out / "mcp" / ("%s-mcp" % name)]:
        s = Study(folder)
        copies[folder.name] = s
        for st in s.studies:
            assert s.study_markdown(st["id"]).strip(), "empty study " + st["id"]
        missing = [e for n in s.nodes for f in n.get("fields", []) for e in f.get("evidenceIds", []) if e not in s.evidence]
        assert not missing, "fields cite unknown evidence: %s" % sorted(set(missing))[:5]
    checks.append("program loads and every study renders in both folders")

    first = next(iter(copies.values()))
    calls = [("study_overview", {})]
    if first.studies:
        calls.append(("read_study", {"study_id": first.studies[0]["id"]}))
    calls.append(("search_study", {"query": (first.program.get("title") or "study").split()[0]}))
    responses, stderr = mcp_session(out / "mcp" / ("%s-mcp" % name) / "server.py", calls)
    assert responses.get(0, {}).get("result", {}).get("capabilities", {}).get("tools") is not None, \
        "MCP initialize failed: %s" % stderr[-500:]
    tools = [t["name"] for t in responses.get(1, {}).get("result", {}).get("tools", [])]
    assert "read_study" in tools and "score_sessions" in tools, "MCP tools/list: %s" % tools
    for i, (tool, _) in enumerate(calls):
        res = responses.get(i + 2, {}).get("result", {})
        assert res and not res.get("isError"), "MCP %s failed: %s %s" % (tool, res, stderr[-500:])
    checks.append("MCP server: initialize, %d tools listed, %d tool calls" % (len(tools), len(calls)))

    for folder, s in copies.items():
        if s.package:
            with tempfile.TemporaryDirectory() as tmp:
                pkg = Path(tmp) / s.package.name  # a copy: files the test writes never reach the export
                shutil.copytree(s.package, pkg)
                run = subprocess.run([sys.executable, str(pkg / "task/adapter.py"), "--smoke-test"],
                                     capture_output=True, text=True, encoding="utf-8", errors="replace",
                                     timeout=300, cwd=str(pkg))
            assert run.returncode == 0, "replay package smoke test failed in %s:\n%s%s" % (folder, run.stdout[-800:], run.stderr[-800:])
    if first.package:
        checks.append("replay package smoke test in both folders")
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
        name = build(root, work, a.include_paper, a.include_sources)
        checks = verify(work, name)
        work.rename(out)
    except (AssertionError, OSError, RuntimeError, KeyError) as exc:
        print("FAIL %s" % exc, file=sys.stderr)
        return 2
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    for c in checks:
        print("ok   " + c)
    size = sum(p.stat().st_size for p in out.rglob("*") if p.is_file())
    print("PASS %s (%.1f KB): skill/%s and mcp/%s-mcp" % (out, size / 1024, name, name))
    return 0


if __name__ == "__main__":
    sys.exit(main())
