# Research runtime

Social scientists' machines have no Python, poppler or R, and on a clean Mac `python3` opens the
"install the command line developer tools" dialog. The pack's skills need `python3` (numpy, scipy,
pandas, statsmodels, matplotlib), `pdftotext` and `pdfinfo`. The app therefore installs a private
runtime on first run, next to the kernel, and puts it first on the kernel's PATH.

## What is installed

`userData/runtime/<version>/` (version = Python + PBS tag + 10 hex of the lock file's SHA-256):

| Path | Content |
|---|---|
| `python/` | CPython 3.12.15, [python-build-standalone](https://github.com/astral-sh/python-build-standalone) 20261009 `install_only_stripped` (darwin arm64 / x64, windows x64); pinned by URL and SHA-256 in `runtime-core.ts` |
| `python/**/site-packages` | the wheels of `pack/runtime/requirements.lock` (50 pins incl. dependencies), installed with `pip install --require-hashes --only-binary :all: --no-deps`; plus `humanstudy_llm.py` and `hs_pdf_tools.py` from `pack/runtime/lib` |
| `bin/` | `python`, `python3`, `pip`, `pip3`, `pdftotext`, `pdfinfo`, `hs-pdf` (sh scripts; `.cmd` on Windows) |
| `.ok` | the runtime version, written last; no marker = not installed (the download resumes, pip reuses its cache) |

Download: about 128 MB (25 MB Python + 103 MB wheels, Intel Mac; Apple Silicon similar), plus the 46 MB
kernel. On disk about 575 MB. A changed lock file installs a new folder and removes the old one.

## How it reaches the agent

- `runtime-install.ts` (electron) installs it and publishes `HUMANSTUDY_RUNTIME_BIN`: the runtime's `bin/`, or
  while it is missing a stub `bin/` whose `python`, `pdftotext`, ... print "runtime not installed" and exit 127.
- `kernel/opencode.ts` `kernelEnv()` calls `kernelRuntimeEnv()` (`runtime-core.ts`): `bin/` first on PATH,
  `PYTHONNOUSERSITE=1`, `MPLBACKEND=Agg`, `PIP_DISABLE_PIP_VERSION_CHECK=1`, `PYTHONUTF8=1`; `PYTHONHOME`,
  `PYTHONPATH`, `VIRTUAL_ENV` removed. It also exports `HUMANSTUDY_MODEL` (the selected model).
- `assistant-install.ts` runs kernel and runtime installs in parallel and reports one `KernelInstallStatus`
  (`state`, `percent` over both, `phase` = `kernel` | `runtime`, `runtimeVersion`). The renderer's KernelBar needs no change.

## Shims

`pdftotext [-layout] [-f N] [-l N] [-nopgbrk] file.pdf [out.txt|-]` writes one form feed after every page,
like poppler; `pdfinfo` prints `Title:`, `Pages:` and a few other fields; `hs-pdf pages paper.pdf` prints
`=== page N ===` blocks and warns on stderr about pages without a text layer (no OCR). They use pdfplumber
(pypdf as fallback). Output is not byte-identical to poppler but has the same page count and words.

## LLM access

`from humanstudy_llm import llm, chat, llm_many` calls `HUMANSTUDY_HOSTED_BASEURL/chat/completions` with
`HUMANSTUDY_DESKTOP_KEY` (+ `x-vercel-protection-bypass` from `HUMANSTUDY_SERVER_BYPASS`). Model:
`HUMANSTUDY_SIM_MODEL`, else `HUMANSTUDY_MODEL`. Retries 429/5xx/network with backoff (honours Retry-After),
at most `HUMANSTUDY_LLM_CONCURRENCY` (8) calls in flight, usage lines (no prompt text, no key) appended to
`<project>/.humanstudy/tmp/llm-usage.jsonl`. The key lives only in the process environment.

## Signing and Gatekeeper

Nothing here is inside the notarized app bundle: it is downloaded after install by the app itself (Node
`fetch` and `tar`, python's pip), so files carry no `com.apple.quarantine` attribute and Gatekeeper
does not assess them (verified: `xattr -lr` on an install shows none). Apple Silicon only requires a
signature, and python-build-standalone and the macOS wheels ship ad-hoc/linker-signed binaries
(`codesign -v` valid). The first import of each native module is slow (XProtect scans it, ~30 s for the whole set on a cold
machine); the install's last step does that once. Dmg builds need no extra signing step for the runtime.

## Developing

```bash
cd app
node scripts/install-runtime.mjs /tmp/hs-rt            # real install, same code as the app
PATH=/tmp/hs-rt/bin:$PATH python -m unittest discover -s ../pack/runtime/tests
HUMANSTUDY_TEST_PYTHON=/tmp/hs-rt/bin/python node --test src/main/runtime.test.mjs
HUMANSTUDY_KERNEL_BIN=<opencode> HUMANSTUDY_RUNTIME_BIN=/tmp/hs-rt/bin node scripts/kernel-runtime-live.mjs
```
