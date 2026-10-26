"""Agent package export: one program becomes a skill folder and an MCP server, verified before it appears.
   python -m unittest discover -s pack/runtime/tests"""
import json
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


class AgentPackage(unittest.TestCase):
    def setUp(self):
        self.root = make_project()
        self.addCleanup(shutil.rmtree, self.root, True)

    def test_export_builds_and_verifies_skill_and_mcp(self):
        run = export(self.root)
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertIn("PASS", run.stdout)
        out = self.root / "exports/agent"
        skill, server = out / "skill/study-5", out / "mcp/study-5-mcp/server.py"
        text = (skill / "SKILL.md").read_text(encoding="utf-8")
        self.assertTrue(text.startswith("---\nname: study-5\ndescription: "))
        for ref in ["study-exp-1.md", "study-exp-2.md", "paper.md", "open-issues.md", "sources.md"]:
            self.assertTrue((skill / "references" / ref).is_file(), ref)
        self.assertEqual((skill / "program.json").read_bytes(), PROGRAM.read_bytes(), "program is an exact copy")
        manifest = json.loads((out / "MANIFEST.json").read_text(encoding="utf-8"))
        self.assertIn("skill/study-5/SKILL.md", manifest["files"])
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
        self.assertEqual(len(plan["participants"]), 4)
        scored = json.loads(res[5]["result"]["content"][0]["text"])
        self.assertEqual(scored["evaluation"]["yes"], {"condition-harm": {"yes": 2, "n": 2}, "condition-help": {"yes": 0, "n": 2}})
        self.assertTrue(res[6]["result"]["isError"], "a bad id is a tool error, not a dropped connection")

        core = skill / "scripts/study_core.py"
        cli = subprocess.run([sys.executable, str(core), "search", "chairman"], capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(cli.returncode, 0, cli.stderr)

    def test_never_overwrites_and_respects_sharing_flags(self):
        self.assertEqual(export(self.root).returncode, 0)
        self.assertEqual(export(self.root).returncode, 1, "existing exports are never overwritten")
        shutil.rmtree(self.root / "exports")
        run = export(self.root, "--include-paper")
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertTrue((self.root / "exports/agent/skill/study-5/paper.pdf").is_file())

    def test_blocked_study_reads_but_does_not_run(self):
        root = make_project(ready=False)
        self.addCleanup(shutil.rmtree, root, True)
        self.assertEqual(export(root).returncode, 0)
        out = root / "exports/agent"
        self.assertIn("Not ready to run", (out / "skill/study-5/SKILL.md").read_text(encoding="utf-8"))
        res = mcp(out / "mcp/study-5-mcp/server.py", [("plan_participants", {"n": 1})])
        self.assertTrue(res[2]["result"]["isError"])
        self.assertIn("not ready", res[2]["result"]["content"][0]["text"])

    def test_program_without_package_is_reading_only(self):
        shutil.rmtree(self.root / "package")
        run = export(self.root)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertIn("Reading only", (self.root / "exports/agent/skill/study-5/SKILL.md").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
