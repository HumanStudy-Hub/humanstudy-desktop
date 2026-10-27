# Attach human data to a replay package

You are in a HumanStudy project that has a built replay package in `package/<slug>/` and the original
study's human data in `human-data/` (data files and, if present, a codebook). Write
`package/<slug>/human/human_sessions.py` so the package's own analysis can run on the human data.

Read first: `package/<slug>/task/adapter.py` (what a session looks like: `run_participant` and
`parse_reply`), `package/<slug>/evaluation/evaluation.py` (what `evaluate` reads and returns), and the
codebook. Do not change the adapter or the evaluation.

The module must define two functions and use only the Python standard library:

```python
def load(data_dir):
    """Return a list of sessions built from the human data, in the exact shape run_sessions returns:
    {"study", "condition", "arm", "participant", "parsed", "valid", "source": "human"}.
    "parsed" holds the same keys and value types parse_reply produces for that arm. One session per
    human participant and arm they took part in. Apply the exclusions the paper states; say which in
    EXCLUSIONS."""

def key_effects(evaluation):
    """From the dict evaluate(sessions) returns, list the paper's key tests:
    [{"id": "anchoring_1", "label": "...", "estimate": float, "p": float or None,
      "reported": float or None}]
    "estimate" is a signed effect size or difference whose sign matches the paper's predicted
    direction (positive = effect as predicted). "reported" is the same quantity as the paper reports
    it, if it does; otherwise None. Use the same ids whatever sessions produced the evaluation."""
```

Also define `EXCLUSIONS` (a string) and `SOURCE` (a string naming the data files and where they came
from). Map every human response field you use to a codebook entry in a comment. If an arm cannot be
built from the data, leave it out and say so in a module-level `NOT_MAPPED` list with the reason.

Check your work before you finish:

```bash
python - <<'PY'
import sys, json; sys.path.insert(0, "<skill>/scripts/export/agent")  # path to study_core.py
import study_core, importlib.util
st = study_core.Study("package/<slug>")
spec = importlib.util.spec_from_file_location("h", "package/<slug>/human/human_sessions.py")
h = importlib.util.module_from_spec(spec); spec.loader.exec_module(h)
s = h.load("human-data"); ev = st.evaluate(s)
print(len(s), json.dumps(h.key_effects(ev), indent=1))
PY
```

The estimates computed from the human data should be close to what the paper reports. Where they are
not, find out why (wrong column, missing exclusion, different coding) and fix the loader, not the
numbers. Report in at most 10 lines: sessions loaded, arms not mapped, and each key effect with the
human estimate next to the reported one.
