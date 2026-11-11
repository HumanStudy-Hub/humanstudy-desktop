# Windows desktop UX acceptance

Candidate branch `codex/windows-desktop-ux-1111` began at `d414d7f`. The released source baseline inspected was Windows 0.7.2, tag commit `0d9343ffd3a515dda22114a59eeb66ae65c3f8f1`.

- [x] Separate read-only Simulation status from explicit checks. Test cache hits, stale inputs, and legacy execution gating. Unsupported platforms can explicitly collect findings from the bundled static checker without running legacy package code.
- [x] Replace editor and managed pack files by directory entry. Test hard-linked editor targets, export destinations, pack refresh, conflict handling, and failed saves on local storage. New import destinations use exclusive copies.
- [x] Match the p-value comparison and number together. Test equivalent comparator typography and mismatch diagnostics containing the source path and physical page. Compare all four Knobe fixture findings to the retained sample PDF text.
- [x] Resolve source references by named path and digest. Test missing attachments, unique and ambiguous renames, identical words in distinct sources, and changes to same-name PDFs. Show older unbound notes for review without displaying their saved rectangles.
- [x] Retain complete legacy reports and show warnings separately from run blockers. Test an actual older checker fixture that emits a warning for p=1.2, and reopening a persisted matching report.
- [ ] On native Windows, install the exact candidate and record the build commit, installer filename and digest, and Windows version. Compare process launches and project-tree hashes across Simulation open, switch, and refresh. Repeat hard-link checks on NTFS, including ordinary save and import. Inspect the four evidence workflows and warning display. Open an existing 0.7.2 project and a new sample, then verify review, export, and supported protocol execution.

The 0.7.2 bundled sample route used the Knobe PDF and shared sample program. The candidate's new-project sample is Believing What You're Told. The four Knobe threshold findings were verified against the retained Knobe PDF and the separate Knobe fixture. Neither the baseline nor the candidate was exercised in a packaged Windows app on this host.
