# Author and check a study protocol

This is the shared authoring reference. Edit this source in the sandbox and use the Desktop
`scripts/sync_hsenv.sh authoring <sandbox-skills>` command to refresh the packaged copy.
The caller supplies the paths, checkpoint writer, scope and review procedure.

1. **Map the evidence.** List every empirical study and identify the requested execution scope.
   Record each available source's file or URL, version, SHA-256 and licence in `meta.sources`.
   Cite physical pages or material locations. Preserve exact excerpts and do not invent wording,
   findings, statistics or page numbers. Use the administered instrument for participant experience,
   and the paper and authorized analysis code for reported results and analysis rules. Record source
   conflicts and how they were resolved. External availability does not grant redistribution rights.

2. **Write one execution definition.** Use the installed `protocol.v1.json` schema.
   Preserve the participant's language, page order, randomization, visible history, roles, and
   interactions. Keep outcome keys, scoring, exclusions and unshown conditions out of participant
   state. An arm is an execution scope. Represent conditions within that scope in its data and flow
   when required by the design. Record omitted stages and unsupported analyses with reasons.

3. **Cite each participant-facing item and analysis claim.** A protocol cite has a `label` and
   `source` naming a `meta.sources` entry, with the source location and evidence. Use `verbatim`
   for administered wording, `reported` for sourced descriptions or numbers, `derived` for
   transformations with a stated basis, and `missing` for unavailable material. Use exact
   participant text for a runnable arm, including any response options. A description or a
   translation absent from the administered instrument cannot supply missing wording. Mark an arm
   `runnable: false` and record its reason when its original flow cannot be supported. For new
   arms use `why`, which the engine and preview both read. Distinguish an unprepared scope from
   an unavailable source. Keep existing blocked arm reason fields when maintaining an older draft.

4. **Check and preview the saved protocol.** Use the installed `hsenv.schema_check` and
   `hsenv.checks`, with source-text mappings for cited sources. Check schema and references,
   participant-state leakage, wording, flow and supported analysis for the prepared scope. Use
   engine-rendered previews and seeded diagnostic sessions where applicable. Record the results
   against the saved protocol version. Keep unresolved gaps explicit. Mechanical checks and
   diagnostic answers cannot establish independent fidelity or human replication.
