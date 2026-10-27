"""Agent package export: one program becomes a skill folder and an MCP server, verified before it appears.
   python -m unittest discover -s pack/runtime/tests"""
import json
import shlex
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
EXPORT = REPO / "pack/skills/export/agent_package.py"
PROGRAM = REPO / "app/src/shared/sample-program.json"

ADAPTER = '''import json, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
print("adapter imported")  # package code that prints must not break the MCP stream
def build_prompt(study, condition):
    return "Story for %s. Did the chairman act intentionally? Answer yes or no." % condition
def parse_reply(study, condition, reply):
    return "yes" if "yes" in reply.lower() else "no"
def run_sessions(llm, seed, n, arms=None):
    out = []
    for c in arms or ["condition-harm", "condition-help"]:
        for i in range(n):
            p = build_prompt("exp-1", c)
            r = llm(p)
            out.append({"condition": c, "arm": c, "participant": i + 1, "reply": r, "answer": parse_reply("exp-1", c, r)})
    return out
if __name__ == "__main__" and "--smoke-test" in sys.argv:
    print("smoke ok")
'''
EVALUATION = '''def evaluate(sessions):
    out = {}
    for s in sessions:
        out.setdefault(s["condition"], {"yes": 0, "n": 0})
        out[s["condition"]]["n"] += 1
        out[s["condition"]]["yes"] += s["answer"] == "yes"
    return {"status": "ok", "yes": out}
'''


def make_project(ready=True):
    root = Path(tempfile.mkdtemp(prefix="agent-package-"))
    shutil.copy(PROGRAM, root / "program.json")
    (root / "paper.pdf").write_bytes(b"%PDF-1.4 sample")
    pkg = root / "package/knobe"
    for sub in ["task", "evaluation", "materials", "source", "audit"]:
        (pkg / sub).mkdir(parents=True)
    (pkg / "task/adapter.py").write_text(ADAPTER)
    (pkg / "task/task.json").write_text("{}")
    (pkg / "evaluation/evaluation.py").write_text(EVALUATION)
    (pkg / "study.json").write_text(json.dumps({"readiness": {"status": "ready" if ready else "blocked",
                                                              "blocking": [] if ready else ["iss-x"]}}))
    return root


def export(root, *args):
    return subprocess.run([sys.executable, str(EXPORT), "--output", "exports/agent", *args],
                          cwd=str(root), capture_output=True, text=True, encoding="utf-8", timeout=300)


def mcp(server, calls):
    msgs = [{"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}]
    msgs += [{"jsonrpc": "2.0", "id": i + 2, "method": "tools/call", "params": {"name": n, "arguments": a}}
             for i, (n, a) in enumerate(calls)]
    run = subprocess.run([sys.executable, str(server)], input="\n".join(map(json.dumps, msgs)) + "\n",
                         capture_output=True, text=True, encoding="utf-8", timeout=120)
    return {m["id"]: m for m in map(json.loads, run.stdout.splitlines())}


def quote(path):
    """Quote an executable path for a command line on this platform."""
    return '"%s"' % path if os.name == "nt" else shlex.quote(path)


class AgentPackage(unittest.TestCase):
    def setUp(self):
        self.root = make_project()
        self.addCleanup(shutil.rmtree, self.root, True)

    def test_export_builds_and_verifies_skill_and_mcp(self):
        run = export(self.root, "--mcp")
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertIn("PASS", run.stdout)
        out = self.root / "exports/agent"
        skill = out / "study-5"
        server = skill / "scripts/mcp_server.py"
        text = (skill / "SKILL.md").read_text(encoding="utf-8")
        self.assertTrue(text.startswith("---\nname: study-5\ndescription: "))
        for ref in ["study-exp-1.md", "study-exp-2.md", "paper.md", "open-issues.md", "sources.md"]:
            self.assertTrue((skill / "references" / ref).is_file(), ref)
        self.assertEqual((skill / "program.json").read_bytes(), PROGRAM.read_bytes(), "program is an exact copy")
        manifest = json.loads((out / "MANIFEST.json").read_text(encoding="utf-8"))
        self.assertIn("study-5/SKILL.md", manifest["files"])
        self.assertEqual(manifest["mcpServer"], "study-5/scripts/mcp_server.py")
        self.assertTrue((skill / "references/accuracy.md").is_file())
        self.assertFalse(list(out.rglob("paper.pdf")), "the paper is not shared by default")
        self.assertIn("| `paper.pdf` |", (skill / "references/sources.md").read_text(encoding="utf-8"), "its hash is recorded")
        self.assertFalse([p for p in out.rglob("*") if p.name.startswith(".agent-package-")])

        res = mcp(server, [("study_overview", {}), ("read_study", {"study_id": "exp-1"}),
                           ("plan_participants", {"n": 2}),
                           ("score_replies", {"n": 2, "replies": ["Yes.", "yes", "No", "no way"]}),
                           ("read_study", {"study_id": "nope"})])
        self.assertIn("tools", res[0]["result"]["capabilities"])
        names = [t["name"] for t in res[1]["result"]["tools"]]
        self.assertIn("plan_participants", names)
        self.assertIn("Experiment 1", res[3]["result"]["content"][0]["text"])
        plan = json.loads(res[4]["result"]["content"][0]["text"])
        self.assertEqual(len(plan["prompts"]), 4)
        scored = json.loads(res[5]["result"]["content"][0]["text"])
        self.assertEqual(scored["evaluation"]["yes"], {"condition-harm": {"yes": 2, "n": 2}, "condition-help": {"yes": 0, "n": 2}})
        self.assertTrue(res[6]["result"]["isError"], "a bad id is a tool error, not a dropped connection")

        core = skill / "scripts/study_core.py"
        cli = subprocess.run([sys.executable, str(core), "search", "chairman"], capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(cli.returncode, 0, cli.stderr)

    def test_skill_only_by_default(self):
        self.assertEqual(export(self.root).returncode, 0)
        out = self.root / "exports/agent"
        self.assertFalse((out / "study-5/scripts/mcp_server.py").exists())
        self.assertFalse((out / "mcp").exists())
        self.assertNotIn("mcp add", (out / "README.md").read_text(encoding="utf-8"))

    def test_command_split_drops_quotes_and_keeps_windows_paths(self):
        sys.path.insert(0, str(REPO / "pack/skills/export/agent"))
        import study_core
        line = '"C:\\Program Files\\Python\\python.exe" -c "print(1)" --model haiku'
        self.assertEqual(study_core.split_command(line, windows=True),
                         ["C:\\Program Files\\Python\\python.exe", "-c", "print(1)", "--model", "haiku"])
        self.assertEqual(study_core.split_command("claude -p --model 'haiku 4'", windows=False),
                         ["claude", "-p", "--model", "haiku 4"])

    def test_cli_participants_each_get_a_fresh_process_in_an_empty_folder(self):
        sys.path.insert(0, str(REPO / "pack/skills/export/agent"))
        import study_core
        fake = ('%s -c "import os,sys; sys.stdin.read(); '
                'print(\'yes\' if not os.listdir(\'.\') else \'saw files\', os.getpid())"' % quote(sys.executable))
        result = study_core.Study(self.root).run(study_core.cli_llm(fake), n=2)
        replies = [x["reply"] for x in result["sessions"]]
        self.assertTrue(all(r.startswith("yes ") for r in replies), replies)
        self.assertEqual(len({r.split()[1] for r in replies}), 4, "one process per participant")
        self.assertIn("simulation", result["note"])

    def test_quote_check_finds_wrong_pages_and_missing_quotes(self):
        sys.path.insert(0, str(REPO / "pack/skills/build"))
        import check_quotes
        pages = ["Title page. Participants were 80 undergraduates.",
                 "Method. Each subject read one of four stories and then estimated the percentage of peers.",
                 "Results. The combined effect was F(1, 312) = 49.1, p < .001 for consensus."]
        original = check_quotes.Pdf.load
        check_quotes.Pdf.load = lambda self: (setattr(self, "reader", "test") or pages)
        self.addCleanup(setattr, check_quotes.Pdf, "load", original)
        program = json.loads(PROGRAM.read_text(encoding="utf-8"))
        program["evidence"] = [
            {"id": "ok", "locator": {"page": 2}, "quote": "Each subject read one of four\nstories"},
            {"id": "slip", "locator": {"page": 3}, "quote": "The combined effect was F(1, 312) = 49.7, p < .001"},
            {"id": "page", "locator": {"page": 1}, "quote": "estimated the percentage of peers"},
            {"id": "gone", "locator": {"page": 2}, "quote": "Participants were paid ten dollars for an hour"}]
        (self.root / "program.json").write_text(json.dumps(program), encoding="utf-8")
        report = check_quotes.check(self.root / "program.json")
        status = {r["id"]: r["status"] for r in report["results"]}
        self.assertEqual(status, {"ok": "found", "slip": "close", "page": "other_page", "gone": "not_found"})

    def test_never_overwrites_and_respects_sharing_flags(self):
        self.assertEqual(export(self.root).returncode, 0)
        self.assertEqual(export(self.root).returncode, 1, "existing exports are never overwritten")
        shutil.rmtree(self.root / "exports")
        run = export(self.root, "--include-paper")
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertTrue((self.root / "exports/agent/study-5/paper.pdf").is_file())

    def test_blocked_study_reads_but_does_not_run(self):
        root = make_project(ready=False)
        self.addCleanup(shutil.rmtree, root, True)
        self.assertEqual(export(root, "--mcp").returncode, 0)
        out = root / "exports/agent"
        self.assertIn("Not ready to run", (out / "study-5/SKILL.md").read_text(encoding="utf-8"))
        res = mcp(out / "study-5/scripts/mcp_server.py", [("plan_participants", {"n": 1})])
        self.assertTrue(res[2]["result"]["isError"])
        self.assertIn("not ready", res[2]["result"]["content"][0]["text"])

    def test_program_without_package_is_reading_only(self):
        shutil.rmtree(self.root / "package")
        run = export(self.root)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertIn("Reading only", (self.root / "exports/agent/study-5/SKILL.md").read_text(encoding="utf-8"))


def raw_server(server, lines):
    run = subprocess.run([sys.executable, str(server)], input=b"\n".join(lines) + b"\n",
                         capture_output=True, timeout=120)
    return [json.loads(l) for l in run.stdout.decode("utf-8").splitlines()], run.returncode


class ReviewRegressions(unittest.TestCase):
    """Findings of the independent review on 2026-10-25."""

    def setUp(self):
        sys.path.insert(0, str(REPO / "pack/skills/export/agent"))
        import study_core
        self.core = study_core
        self.root = make_project()
        self.addCleanup(shutil.rmtree, self.root, True)

    def test_server_survives_malformed_input_and_follows_jsonrpc(self):
        self.assertEqual(export(self.root, "--mcp").returncode, 0)
        server = self.root / "exports/agent/study-5/scripts/mcp_server.py"
        out, code = raw_server(server, [
            b"1", b"\xff\xfe", b'{"jsonrpc":"2.0","id":2,"method":"ping","params":[1]}',
            b'{"jsonrpc":"2.0","id":3,"result":{}}',
            b'{"jsonrpc":"2.0","id":4,"method":"initialize","params":{"protocolVersion":"2099-01-01"}}',
            b'[{"jsonrpc":"2.0","id":5,"method":"ping"},{"jsonrpc":"2.0","method":"notifications/initialized"}]',
            b'{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"search_study","arguments":{"query":"x","limit":"3"}}}',
            b'{"jsonrpc":"2.0","id":7,"method":"ping"}'])
        self.assertEqual(code, 0)
        self.assertEqual(out[0]["error"]["code"], -32600)
        self.assertEqual(out[1]["error"]["code"], -32700)
        self.assertEqual(out[2]["error"]["code"], -32602)
        self.assertEqual(out[3]["result"]["protocolVersion"], "2025-06-18", "a client response (id 3) gets no reply")
        self.assertEqual(out[4], [{"jsonrpc": "2.0", "id": 5, "result": {}}], "a batch is answered as one array")
        self.assertTrue(out[5]["result"]["isError"])
        self.assertEqual(out[6]["id"], 7)

    def test_blocked_study_refuses_every_running_tool(self):
        root = make_project(ready=False)
        self.addCleanup(shutil.rmtree, root, True)
        s = self.core.Study(root)
        for call in [lambda: s.participant_prompt("exp-1", "condition-harm"), lambda: s.evaluate([]),
                     lambda: s.parse_reply("exp-1", "condition-harm", "yes")]:
            with self.assertRaisesRegex(RuntimeError, "iss-x"):
                call()

    def test_replay_rejects_unused_replies(self):
        s = self.core.Study(self.root)
        with self.assertRaisesRegex(RuntimeError, "expected 2"):
            s.replay(["yes", "no", "extra"], 1)
        self.assertEqual(s.replay(["yes", "no"], 1)["evaluation"]["status"], "ok")

    def test_adapter_with_dataclasses_and_positional_llm_arguments(self):
        (self.root / "package/knobe/task/adapter.py").write_text(
            "from __future__ import annotations\nfrom dataclasses import dataclass\n"
            "@dataclass\nclass P:\n    c: str\n"
            "def run_sessions(llm, seed, n, arms=None):\n"
            "    return [{'condition': c, 'arm': c, 'answer': llm('q ' + P(c).c, 'system text')}"
            " for c in ['condition-harm'] for _ in range(n)]\n", encoding="utf-8")
        s = self.core.Study(self.root)
        self.assertEqual(len(s.plan(2)["prompts"]), 2)

    def test_rendering_keeps_flags_rules_cycles_and_safe_file_names(self):
        program = json.loads(PROGRAM.read_text(encoding="utf-8"))
        program["studies"].append({"id": "exp:3", "title": "Colon study", "type": "empirical"})
        program["nodes"].append({"id": "m3", "kind": "material", "title": "M", "studyIds": ["exp:3"], "fields": [
            {"id": "t", "label": "Text", "value": "OCR text", "origin": "verbatim", "state": "check", "evidenceIds": []}]})
        program["steps"] += [
            {"id": "a3", "studyId": "exp:3", "kind": "action", "title": "Step A", "children": ["b3"], "conditionIds": ["condition-harm"],
             "rule": {"id": "r", "label": "Order", "value": None, "origin": "unknown", "state": "missing", "evidenceIds": []}},
            {"id": "b3", "studyId": "exp:3", "kind": "action", "title": "Step B", "children": ["a3"]}]
        (self.root / "program.json").write_text(json.dumps(program), encoding="utf-8")
        md = self.core.Study(self.root).study_markdown("exp:3")
        self.assertIn("(verbatim, to check)", md)
        self.assertIn("Step A", md)
        self.assertIn("Step B", md)
        self.assertIn("Order**: Not stated in the paper.", md)
        self.assertIn("conditions:", md)
        run = export(self.root)
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertTrue((self.root / "exports/agent/study-5/references/study-exp-3.md").is_file())


if __name__ == "__main__":
    unittest.main()
