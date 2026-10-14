# Connection recovery and complete sample (0.5.3-beta.3)

The agent UI can miss the last reply or keep waiting if its OpenCode event stream drops.
The client previously reconnected without fetching the events missed during the gap.
It now repairs observation from the running local server's saved messages, session status,
pending questions and permissions. It does not resend the user's task or rerun a tool to
repair a connection. Absolute text offsets, part IDs and completed-message IDs avoid
repeating text, tools or token usage. Previous conversation turns are excluded.

During catchup the UI shows one reconnecting activity line. Existing researcher questions
and permissions retain priority. Stop is acknowledged even when the native idle event
was missed. A newer user request supersedes an old in-flight snapshot. Requests have
bounded timeouts; repeated snapshot failures stop the repair with an explicit warning that
native work may still be running, while retaining messages and files. Do not treat the
warning as evidence that a remote action was cancelled.

Output-budget recovery remains a separate path: inspect checkpoints, lower reasoning effort
for the hosted recovery variant, and finish smaller complete units without cutting detail.
At most two adjusted attempts are allowed. Another attempt now requires actual visible text
or a completed tool, rather than a positive output-token counter alone. No generic 'continue'
is sent. Permission and simulation decision requirements remain in effect.

## Sample

Creating the editable Knobe sample now installs program.json, the supplied KNOBE.pdf,
a paper.pdf alias, all four condition-material JSON files and a short README walkthrough.
The files are bundled under app/resources/sample and copied from resources/sample in the
packaged app. There is no download at sample creation time. Every sample evidence path
resolves and its /instructions quotation exactly matches the included material file.
Original wording (including source typos) is retained. The sample remains a derived benchmark
reconstruction with unresolved assignment and question-order issues; it is not labelled a
validated runnable package, newly collected human data, or a completed simulation.

Sample installation rejects conflicting files without overwriting researcher edits. Failed
creation does not receive the project marker and is not listed as a usable project.
A sample cannot replace a separately selected user paper. README guides source comparison,
Need input/refinement and export without starting a simulation automatically.

## Verification

- 61 desktop main/kernel/shared regression checks passed (Node test runner).
- Ten connection tests include an actual dropped local HTTP/SSE stream and the installed
  HumanStudy OpenCode hs-v1.19.0 with a localhost compatible-model fixture. The native test
  preserved the complete reply and usage while the model executed only once.
- Native Auto toggle, question answer/reject/abort, and adjusted output-limit recovery were
  also exercised against the installed kernel and local model fixtures.
- Six sample/project checks cover material quotes, PDF bytes, real createProject wiring,
  packaged resource paths, existing edits, missing assets and incompatible inputs.
- TypeScript checks and production build passed. The sample passed check_program.py, and all six resources in the built .app matched their source bytes.

These tests do not consume hosted-model quota or send a research paper to a model. They do
not replace an owner dogfood run using the live hosted service and a real research task.
PDF zoom/text annotations, a full guided onboarding UI, owner account acceptance, support
notification inbox, automatic-update acceptance and broader publishing remain separate work.
Current installed app is not replaced. This branch is based on local integrated desktop release
c0b8587; the remote desktop main is older, so it is not silently pushed as a broad release.
