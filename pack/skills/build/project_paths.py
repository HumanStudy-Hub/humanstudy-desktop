"""One rule for every file path a project file names (program.json `source.filename`, sources/SOURCE.json
`files[].path`, evidence `file`, material `file`): it must stay inside the project and never name
participant data or a key folder.

    from project_paths import project_file
    path = project_file(root, rel)      # a resolved Path inside the project, or None

Relative only (no absolute path, `~`, drive letter or `..` segment), resolved through links, inside the
project after resolving, and no segment (compared after Unicode NFKC and in lower case) that names a
participant-data folder or a key folder. The checkers that read such files print parts of them, and the
desktop agent can start them, so a path in a project file must not reach anything the agent may not read.
Standard library only.
"""
import re
import unicodedata
from pathlib import Path

PARTICIPANT = {"human-data", "human_data", "quarantine", "quarantined", "withheld", "participant-data",
               "participant_data"}
KEY_SEGMENTS = {".ssh", ".aws", ".gnupg", ".netrc", ".git-credentials", ".npmrc", ".pypirc", ".password-store",
                ".kube", ".docker", ".azure", "keychains", ".env"}


def _norm(segment):
    return unicodedata.normalize("NFKC", segment).lower()


def sensitive(rel):
    """True when a segment of `rel` names a participant-data folder or a key folder or file."""
    return any(_norm(s) in PARTICIPANT or _norm(s) in KEY_SEGMENTS for s in str(rel).replace("\\", "/").split("/"))


def project_file(root, rel):
    """The path `rel` (as written in a project file) names inside the project, or None."""
    if not isinstance(rel, str) or not rel.strip():
        return None
    raw = rel.strip().replace("\\", "/")
    if raw.startswith(("/", "~")) or re.match(r"^[A-Za-z]:", raw) or ".." in raw.split("/") or sensitive(raw):
        return None
    root = Path(root).resolve()
    try:
        path = (root / raw).resolve()
    except (OSError, RuntimeError):
        return None
    if path != root and root not in path.parents:
        return None
    if sensitive(path.relative_to(root).as_posix()):
        return None
    return path
