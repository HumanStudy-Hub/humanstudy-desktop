# Complete research document; requested experiment preparation

This is the public draft contract. It does not include the private high-fidelity review pipeline.

Use schema/human-program.schema.json, schemaVersion 2, with all required arrays. `steps` is empty for this
profile: executable definitions live only in protocol.json. Root extension:

```
"extensions": {"scholarly": {
  "profile": "scholarly-v1", "status": "draft",
  "protocol": {"path": "protocol.json", "id": "<protocol id>", "sha256": "<raw UTF-8 file hash>"}
}}
```

Map every protocol arm to its actual experiment in studies[]. Matching ids work by default; when a study uses multiple arms or a different id, set extensions.scholarly.studyArms to an object mapping study ids to arrays of protocol arm ids. Do not promote conditions or execution scopes to separate studies. Explain study relationships in descriptions
and relations. Required node kinds: background (question, motivation/theory), hypothesis, design, participants,
material, procedure, variable, analysis, result, finding (conclusions), limitation. These are coverage categories,
not eleven mandatory UI panels. Nodes/fields use the schema's studyIds and evidenceIds; original-source
evidence has file/source, physical page or source pointer, and the relevant full quote. Do not cite the program
itself as evidence. `extensions.effectRefs` on result nodes names existing protocol analysis effect/target ids;
reference them instead of copying calculation definitions. Use shared nodes only where their scope really is shared.

Source statements can be reported or verbatim. Interpretations are derived with an explanation. User changes
are researcher-origin; preserve them. Proposed mechanisms are distinct from mechanisms actually tested.
Keep original human results separate from generated outcomes and a replay's unsupported analyses separate
from limitations stated by the paper. A complete document can contain uncertainty, not unfinished extraction.

For an absent value use state missing, value null and a review issue pointing to the node/field. Its extension
`gapReason` is `not_reported` (cite the source and explain what was checked) or `source_unavailable` (name
what is needed). `not_extracted` is a checkpoint, not completion. Never infer an a-priori hypothesis backwards
from the reported results. Do not turn uncertainty into an invented rule.

Save with `program_io.py <patch> --expected-hash <current raw SHA-256 or absent>`; the hash is checked under the shared lock. Re-read after conflicts. It merges records by id and protects confirmed researcher fields. Run
`python .opencode/skills/build/check_program.py program.json --complete`. New paired drafts also declare
`protocol.meta.delivery: research-program-v1`; the app independently checks scholarly coverage, references,
current protocol pin and preview before marking the build complete. Hashes establish identity, not fidelity.

When the user asks to run one experiment, use their current context to prepare its supported scope. Do not
force them through a whole-paper form or silently omit other studies from the research document. Request
only missing material or a consequential scientific choice, using OpenCode's question tool where useful.
If exact core wording is missing, preserve the blocked original and propose a separate researcher-confirmed
variant. This approval is not a paid simulation approval; Simulation still confirms model, scope and budget.
No autonomous high-fidelity review loop or paid trial is part of initial build.
