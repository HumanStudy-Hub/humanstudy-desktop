"""project_paths.project_file: a path a project file names stays inside the project and never names
participant data or keys (review 4: helpers printed files named by program.json / SOURCE.json)."""
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "skills" / "build"))
from project_paths import project_file  # noqa: E402


class ProjectFileTest(unittest.TestCase):
    def test_inside_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "study"
            (root / "sources" / "open").mkdir(parents=True)
            (root / "Human-Data").mkdir()
            (root / "sources" / "open" / "si.pdf").write_text("x")
            (Path(tmp) / "secret.txt").write_text("s")
            os.symlink(str(Path(tmp) / "secret.txt"), str(root / "sources" / "link.txt"))
            self.assertEqual(project_file(root, "sources/open/si.pdf"), (root / "sources/open/si.pdf").resolve())
            for bad in ["../secret.txt", "../../r4/k2/secret.txt", "/etc/passwd", "~/.ssh/config", "C:/x", "sources/../../secret.txt",
                        "human-data/a.csv", "HUMAN-DATA/a.csv", "ｈｕｍａｎ-ｄａｔａ/a.csv", "sources/link.txt", ".ssh/id_rsa", "", None, 3]:
                self.assertIsNone(project_file(root, bad), bad)


if __name__ == "__main__":
    unittest.main()
