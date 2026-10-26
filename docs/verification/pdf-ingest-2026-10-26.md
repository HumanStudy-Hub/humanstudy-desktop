# PDF upload/build investigation — 2026-10-26

A tester reported that uploading a PDF left Build loading until it failed. The
platform, app version, paper and job ID are unknown, so the original incident's
root cause is not established.

## Findings

- Desktop imports copy the PDF locally without a 25 MiB limit. The web studio's
  paper limit is 25 MiB; it uploads PDF bytes directly to Storage using a signed
  URL rather than sending the PDF through a Vercel function body.
- Desktop's PDF text reader accumulated every selected page before printing any
  output and retained extracted-page parser caches. Long papers could therefore
  remain silent and retain unnecessary page layout data during extraction.
- File size and model request size are different. Existing desktop transport
  protection archives historical inline media/tool content when requests exceed
  3.6 MB, targeting 2 MB. This does not guarantee every possible request fits:
  attaching whole PDFs or returning whole-paper text remains inappropriate.

## Changes

- Emit and flush each extracted page as it finishes, preserving the previous
  output format and every page's complete text.
- Release each page's parser/layout cache after extraction, including fallback
  handling. No source PDF bytes are changed.
- Tell the build agent to inspect page count, extract normally five pages at a
  time into project-local text files, read all batches, and checkpoint progress.
  Handle unreadable pages explicitly rather than retrying the same whole file.
  No source, quote or page truncation is permitted.

## Verification

- Python runtime suite: 16 tests passed, including incremental output/cache
  release, complete 100-page extraction, a real two-page PDF containing a shared
  uncompressed RGB image over 25 MiB, and password-protected PDF failure.
- The image-heavy fixture's original SHA-256 remains unchanged after extraction;
  its extracted text is under 1 KiB. Large source bytes need not become a large
  model request.
- The incremental-output regression test fails against the released extractor.
- Existing desktop request transport, paper build state and recovery suites:
  16 tests passed against release 0.6.7.

These are synthetic PDF and local transport/state tests. No complete real-model
paper build, packaged application acceptance test, release or automatic update
was performed for this patch. Prompt batching is guidance, not a hard execution
limit. Parser cache release does not impose a total memory or runtime limit.
Scanned pages still require visual inspection; OCR is not added here.
