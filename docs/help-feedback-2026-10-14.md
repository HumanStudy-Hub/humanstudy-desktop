# Help & feedback implementation

The desktop Settings dialog and native Help menu provide Help & feedback. Signed-in users can submit a private `support_requests` row through owner-scoped PostgREST. Each submission has a UUID receipt; retries reuse the same UUID so inserts are idempotent. Supported kinds are `help`, `problem`, and `suggestion`. Reply email is optional. Diagnostics are off by default and, when selected, include only app version, platform, and architecture.

There are no attachments or automatic email notifications, and no team inbox address has been chosen. The team can review requests in the Supabase Table Editor (`support_requests`), change status to `open`, `in_progress`, or `resolved`, and reply to a user-supplied email using its own email client. No message is sent automatically. Browser preview is intentionally unavailable and does not fake successful submission.

Six support fixture tests pass. Database metadata confirms owner-only RLS `SELECT` and `INSERT`, with no user `UPDATE` or `DELETE` policy. A live cross-user runtime test has not been done because auth-fixture setup was blocked by automatic review. Production auth PR 17 has merged; production `/auth/reset` and public config returned HTTP 200. Owner password reset and acceptance of a new login are still pending.

Production recovery email test: the public page sent one message to the owner's designated test address; Resend 01a13c4e-64c3-796b-9a04-a618cfdfe98e shows Delivered. No recovery token was read or consumed.

The beta.2 app uses https://humanstudy-hub.com for both hosted models and authentication callbacks. Apple app notarization completed, stapler validation succeeded, and Gatekeeper returned accepted / Notarized Developer ID. Current installed application remains unchanged.

Web migration and rollout record: draft PR https://github.com/HumanStudy-Hub/humanstudy-hub-web/pull/18. Desktop changes are committed locally on codex/beta-account-desktop, based on the existing integrated release c0b8587; they are not pushed over the much older remote desktop main.
