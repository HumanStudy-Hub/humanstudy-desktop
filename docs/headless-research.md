# Headless account and research collection

Each collaborator runs under their own HumanStudy account. A genuinely shared automated batch
runner may use a dedicated service account, identified separately from human contributions.
The worker never discovers or copies the owner's desktop credentials.

## Agreement version 3

Running the worker requires explicit agreement to collect interaction events and research content:
full submitted conversations and agent outputs, tools, Human Program/artifact versions, and the
original papers/resources imported into the project. Sources are stored privately under the
account and deduplicated by SHA-256. Uploading does not publish files to the community.
There is no mouse movement, individual keystroke, screen/DOM recording or other-app capture.
Account holders and the HumanStudy research team can read the records. Contact Help & feedback
for questions or deletion requests. The agreement is mandatory for the research workspace.

## Sign in once

Use `app/scripts/research-auth.mjs --server https://humanstudy-hub.com --file <private-path>
--agree-research-v3`. It reads `{ "email": "…", "password": "…", "invitationCode": "…" }`
from stdin, not command arguments. Supply it from a private terminal or secure credential
manager; never paste credentials into an agent chat, an issue, source bundle or PR. The optional
invitation code enables hosted model access for that same account.

The profile contains access/refresh tokens (and hosted key when unlocked), not the password.
Keep it outside the project and repositories; Unix permissions must be `0600`. In CI, supply
it from a secret file with a dedicated batch account. Do not commit the profile or raw stdin.
The worker refreshes the session, verifies its owner with Supabase, and verifies that hosted
model access belongs to the same account. A mismatch stops before generation.

## Run

Add `--research-auth <private-path>` to `app/scripts/opencode-assets.mjs` alongside the existing
project, binary and managed runtime arguments. `--doctor` verifies account/runtime compatibility
without generation or source upload. Its account check needs the web identity endpoint from the
research-collection PR to be deployed first.

Before generation, sources are copied into the private durable queue under
`<project>/.humanstudy/asset-agent/research-data/<owner-id>/`. Upload failures leave them there;
there is no age/count pruning. The next run retries; duplicate events/content do not multiply.
A pending-delivery notice at exit is not a claim that data reached the server. Keep `.humanstudy/`
out of exported/public asset bundles. This change adds source collection and account attribution;
the full headless conversation/tool adapter remains part of issue #27.
