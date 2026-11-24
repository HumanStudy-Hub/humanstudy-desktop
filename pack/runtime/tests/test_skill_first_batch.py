"""The first-batch example in skills/build/SKILL.md stays schema-valid, so an agent that copies it passes
check_program.py on its first save (issue #91), and the per-study areas it lists match the coverage policy.
   python -m unittest discover -s pack/runtime/tests"""
import json
import re
import sys
import unittest
from pathlib import Path

PACK = Path(__file__).resolve().parents[2]
BUILD = PACK / "skills" / "build"
sys.path.insert(0, str(BUILD))
import check_program  # noqa: E402
import program_io  # noqa: E402

SKILL = (BUILD / "SKILL.md").read_text(encoding="utf-8")
SCHEMA = json.loads((PACK / "schema" / "human-program.schema.json").read_text(encoding="utf-8"))


def example() -> dict:
    m = re.search(r"<!-- first-batch-example:start -->\s*```json\n(.*?)```\s*<!-- first-batch-example:end -->", SKILL, re.S)
    assert m, "SKILL.md lost its first-batch example block"
    return json.loads(m.group(1))


def has_jsonschema():
    try:
        import jsonschema  # noqa: F401
        return True
    except ImportError:
        return False


class FirstBatchExampleTest(unittest.TestCase):
    def setUp(self):
        self.batch = example()
        # Saved the way program_io.py saves a first batch onto an empty project.
        self.program = program_io.apply({}, self.batch)

    def test_passes_the_program_checker(self):
        self.assertEqual(check_program.check(self.program), [])

    @unittest.skipUnless(has_jsonschema(), "needs jsonschema (the research runtime has it)")
    def test_passes_the_json_schema(self):
        self.assertEqual(check_program.schema_problems(self.program, BUILD / "check_program.py"), [])

    def test_source_and_studies_match_the_schema_without_jsonschema(self):
        # The keys the first batch kept getting wrong, checked even where jsonschema is not installed.
        props = SCHEMA["properties"]
        for record, spec in [(self.batch["source"], props["source"])] + [(s, props["studies"]["items"]) for s in self.batch["studies"]]:
            self.assertEqual(set(record) - set(spec["properties"]), set(), "keys the schema does not allow")
            self.assertEqual(set(spec["required"]) - set(record), set(), "required keys missing")
            for key, value in record.items():
                kind = spec["properties"][key]
                if "enum" in kind:
                    self.assertIn(value, kind["enum"], key)
                elif kind.get("type") == "string":
                    self.assertIsInstance(value, str, key)
        self.assertEqual(self.batch["source"]["filename"], "paper.pdf")
        self.assertIn(self.batch["intent"], props["intent"]["enum"])

    def test_lists_every_required_area(self):
        policy = json.loads((PACK / "schema" / "build-coverage.json").read_text(encoding="utf-8"))
        section = SKILL[SKILL.index("**Plan one batch per area, per study.**"):]
        section = section[:section.index("\n\n")]
        for area, kinds in policy["empirical"].items():
            self.assertIn(area, section)
            for kind in kinds:
                self.assertIn(f"`{kind}`", section)


if __name__ == "__main__":
    unittest.main()
