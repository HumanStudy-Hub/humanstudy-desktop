import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("prepare_conversion", ROOT / "scripts/prepare_conversion.py")
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class PrepareConversionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.resources = self.root / "digital-resources"
        self.resources.mkdir()
        (self.resources / "design.json").write_text('{"source":"original","missing":["allocation"]}')
        self.project = self.root / "output"

    def test_digital_only_project_uses_exact_pack_without_model_or_desktop(self):
        (self.resources / ".env").write_text("EXAMPLE_SECRET=not-for-export")
        result = helper.prepare(self.project, None, [self.resources])
        self.assertEqual(result["status"], "prepared")
        self.assertFalse((self.project / "paper.pdf").exists())
        self.assertFalse((self.project / "program.json").exists(), "Preparation is not model conversion")
        self.assertEqual((self.project / "sources/digital-resources/design.json").read_bytes(),
                         (self.resources / "design.json").read_bytes())
        self.assertFalse((self.project / "sources/digital-resources/.env").exists())
        self.assertEqual((self.project / ".opencode/skills/build/SKILL.md").read_bytes(),
                         (ROOT / "pack/skills/build/SKILL.md").read_bytes())
        self.assertEqual((self.project / "schema/human-program.schema.json").read_bytes(),
                         (ROOT / "pack/schema/human-program.schema.json").read_bytes())
        self.assertIn("AGENTS.md", (self.project / "CLAUDE.md").read_text())
        manifest = json.loads((self.project / ".humanstudy/conversion-pack.json").read_text())
        self.assertIn(".opencode/artifact-kit/inline.py", manifest["files"])

    def test_existing_project_is_never_overwritten(self):
        self.project.mkdir()
        target = self.project / "AGENTS.md"
        target.write_text("existing custom instructions")
        with self.assertRaisesRegex(ValueError, "already exists"):
            helper.prepare(self.project, None, [self.resources])
        self.assertEqual(target.read_text(), "existing custom instructions")

    def test_opencode_worker_uses_desktop_instructions_without_direct_agent_override(self):
        helper.prepare(self.project, None, [self.resources], engine="opencode")
        self.assertEqual((self.project / "AGENTS.md").read_bytes(), (ROOT / "pack/AGENTS.md").read_bytes())
        manifest = json.loads((self.project / ".humanstudy/conversion-pack.json").read_text())
        self.assertEqual(manifest["engine"], "opencode")
        self.assertIn("program-only", (self.project / "CONVERT.md").read_text())

    def test_symlink_and_recursive_input_fail_before_creating_project(self):
        (self.resources / "linked.json").symlink_to(self.resources / "design.json")
        with self.assertRaisesRegex(ValueError, "Symlink"):
            helper.prepare(self.project, None, [self.resources])
        self.assertFalse(self.project.exists())
        (self.resources / "linked.json").unlink()
        with self.assertRaisesRegex(ValueError, "inside an input"):
            helper.prepare(self.resources / "output", None, [self.resources])
        self.assertFalse((self.resources / "output").exists())

    def test_single_zip_is_preserved_without_extraction(self):
        archive = self.root / "original.zip"
        archive.write_bytes(b"unchanged archive bytes")
        helper.prepare(self.project, None, [archive])
        self.assertEqual((self.project / "sources/original.zip").read_bytes(), archive.read_bytes())

    def test_installed_checker_accepts_native_sample_and_rejects_malformed_program(self):
        helper.prepare(self.project, None, [self.resources])
        target = self.project / "program.json"
        target.write_bytes((ROOT / "app/src/shared/sample-program.json").read_bytes())
        checker = [sys.executable, ".opencode/skills/build/check_program.py", "program.json"]
        good = subprocess.run(checker, cwd=self.project, capture_output=True, text=True)
        self.assertEqual(good.returncode, 0, good.stdout + good.stderr)
        target.write_text('{"schemaVersion":2,"title":42}')
        bad = subprocess.run(checker, cwd=self.project, capture_output=True, text=True)
        self.assertNotEqual(bad.returncode, 0)
        self.assertIn("schema:", bad.stdout, "This regression requires jsonschema, not rule-only checking")


if __name__ == "__main__":
    unittest.main()
