// Research data: the first-run consent dialog and the Settings → Research data section. Both use
// the same plain-language explanation and the same two separate choices.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { TelemetryConsent, TelemetryRecent, TelemetryStatus } from '../../preload/types'

/** Electron prefixes errors from ipcMain handlers; show only the message the main process wrote. */
function errorText(e: unknown, fallback: string): string {
  const msg = e instanceof Error ? e.message : ''
  return msg.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '') || fallback
}

export function ConsentExplainer() {
  return (
    <div className="consent-text">
      <p>
        HumanStudy is a research platform. With your permission, we record how researchers work with the study
        agent so we can study human–AI research practice and improve the app. Interaction data is research data:
        you choose what is collected, you can see exactly what is sent, and you can withdraw and delete it at any
        time.
      </p>
      <p>
        <strong>Never collected:</strong> file contents (papers, programs, artifacts), API keys, your email
        address, or paths outside the project. File names are sent only relative to the project folder.
      </p>
      <p>
        <strong>Where it goes:</strong> the HumanStudy Hub database (Supabase), linked to your Hub account. Only
        your account and the HumanStudy research team can read it.
      </p>
      <p>
        <strong>Withdraw:</strong> Settings → Research data. Turn either choice off at any time, review the last
        100 events, or delete everything sent from your account.
      </p>
    </div>
  )
}

function Choices({ value, onChange }: { value: TelemetryConsent; onChange(v: TelemetryConsent): void }) {
  return (
    <div className="consent-choices">
      <label className="consent-choice">
        <input
          type="checkbox"
          checked={value.usage}
          onChange={(e) => onChange({ usage: e.target.checked, content: e.target.checked && value.content })}
        />
        <span>
          <span className="setting-label">Usage events</span>
          <span className="muted small">
            App and session start and end; which features and panes you use; clicks on program items, citations
            and tabs (ids only); timings; agent turn metadata (duration, tool names, errors); artifacts and
            exports generated.
          </span>
        </span>
      </label>
      <label className={`consent-choice ${value.usage ? '' : 'disabled'}`}>
        <input
          type="checkbox"
          checked={value.usage && value.content}
          disabled={!value.usage}
          onChange={(e) => onChange({ ...value, content: e.target.checked })}
        />
        <span>
          <span className="setting-label">Conversation content</span>
          <span className="muted small">
            The text of your messages to the agent and its replies. Requires usage events.
          </span>
        </span>
      </label>
    </div>
  )
}

export function ConsentDialog({ onDone, onLater }: { onDone(s: TelemetryStatus): void; onLater(): void }) {
  const [value, setValue] = useState<TelemetryConsent>({ usage: false, content: false })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => box.current?.focus(), [])

  const save = async (v: TelemetryConsent) => {
    setBusy(true)
    setError('')
    try {
      onDone(await window.humanstudy.telemetry.setConsent(v))
    } catch (e) {
      setError(errorText(e, 'Could not save your choice.'))
      setBusy(false)
    }
  }

  return (
    <div className="overlay">
      <div className="consent-dialog" role="dialog" aria-modal="true" aria-label="Research data" tabIndex={-1} ref={box}>
        <h2>Help HumanStudy research?</h2>
        <ConsentExplainer />
        <Choices value={value} onChange={setValue} />
        <p className="muted small">Nothing is sent until you confirm. Leaving both unchecked sends nothing.</p>
        {error && <p className="home-error">{error}</p>}
        <div className="row-end">
          <button className="ghost" onClick={onLater} disabled={busy}>
            Decide later
          </button>
          <button className="primary" onClick={() => void save(value)} disabled={busy}>
            {value.usage ? 'Confirm choices' : 'Confirm: share nothing'}
          </button>
        </div>
      </div>
    </div>
  )
}

export function ResearchDataSection() {
  const [status, setStatus] = useState<TelemetryStatus | null>(null)
  const [draft, setDraft] = useState<TelemetryConsent>({ usage: false, content: false })
  const [recent, setRecent] = useState<TelemetryRecent[] | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const apply = useCallback((s: TelemetryStatus) => {
    setStatus(s)
    setDraft({ usage: s.usage, content: s.content })
  }, [])
  useEffect(() => {
    window.humanstudy.telemetry
      .status()
      .then(apply)
      .catch((e: unknown) => setError(errorText(e, 'Could not load research data settings.')))
  }, [apply])

  const run = async (kind: string, task: () => Promise<void>, fallback: string) => {
    setBusy(kind)
    setError('')
    setNotice('')
    try {
      await task()
    } catch (e) {
      setError(errorText(e, fallback))
    } finally {
      setBusy('')
    }
  }
  const save = (v: TelemetryConsent, message: string) =>
    run(
      'save',
      async () => {
        apply(await window.humanstudy.telemetry.setConsent(v))
        if (recent) setRecent(await window.humanstudy.telemetry.recent())
        setNotice(message)
      },
      'Could not save your choice.'
    )
  const loadRecent = () =>
    run('recent', async () => setRecent(await window.humanstudy.telemetry.recent()), 'Could not load recent events.')
  const sendNow = () =>
    run(
      'flush',
      async () => {
        apply(await window.humanstudy.telemetry.flush())
        if (recent) setRecent(await window.humanstudy.telemetry.recent())
      },
      'Could not send.'
    )
  const del = () =>
    run(
      'delete',
      async () => {
        apply(await window.humanstudy.telemetry.deleteMyData())
        setRecent(recent ? [] : null)
        setConfirmDelete(false)
        setNotice('Deleted. Every research event stored for your account has been removed from HumanStudy Hub.')
      },
      'Could not delete your data.'
    )

  if (!status)
    return (
      <section>
        <h2>Research data</h2>
        {error ? <p className="home-error">{error}</p> : <p className="muted">Loading…</p>}
      </section>
    )

  const changed = draft.usage !== status.usage || draft.content !== status.content
  const current = !status.decided
    ? 'Not decided yet: nothing is collected.'
    : status.usage
      ? status.content
        ? 'Sharing usage events and conversation content.'
        : 'Sharing usage events only.'
      : 'Not sharing anything.'

  return (
    <section>
      <h2>Research data</h2>
      {!status.signedIn ? (
        <p className="muted settings-lead">
          Research data is tied to your HumanStudy Hub account. Sign in under Account to choose; while signed out
          nothing is sent.
        </p>
      ) : (
        <p className="settings-lead">{current}</p>
      )}
      {error && <p className="home-error">{error}</p>}
      {notice && <p className="account-notice">{notice}</p>}

      <details className="consent-details">
        <summary>What is collected, why, and where it is stored</summary>
        <ConsentExplainer />
      </details>

      {status.signedIn && (
        <>
          <Choices value={draft} onChange={setDraft} />
          <div className="row-end">
            {status.usage && (
              <button
                className="ghost danger"
                disabled={Boolean(busy)}
                onClick={() => void save({ usage: false, content: false }, 'Turned off. Nothing more will be sent.')}
              >
                Turn off
              </button>
            )}
            <button
              className="primary"
              disabled={Boolean(busy) || (status.decided && !changed)}
              onClick={() => void save(draft, 'Saved.')}
            >
              {busy === 'save' ? 'Saving…' : 'Save choices'}
            </button>
          </div>

          <h3>Activity</h3>
          <div className="setting-row">
            <div>
              <div className="setting-label">
                {status.sent} sent · {status.pending} pending
              </div>
              <div className="muted small">
                {status.lastSentAt ? `Last sent ${new Date(status.lastSentAt).toLocaleString()}` : 'Nothing sent yet.'}
                {status.lastError ? ` · Waiting to retry (${status.lastError})` : ''}
              </div>
            </div>
            <div className="setting-control provider-actions">
              {status.pending > 0 && (
                <button className="ghost" disabled={Boolean(busy)} onClick={() => void sendNow()}>
                  {busy === 'flush' ? 'Sending…' : 'Send now'}
                </button>
              )}
              <button className="ghost" disabled={Boolean(busy)} onClick={() => (recent ? setRecent(null) : void loadRecent())}>
                {recent ? 'Hide recent events' : 'View recent events'}
              </button>
            </div>
          </div>
          {recent && (
            <div className="recent-events">
              {recent.length === 0 ? (
                <p className="muted small">No events recorded on this computer.</p>
              ) : (
                <>
                  <p className="muted small">The last {recent.length} events, newest first, exactly as uploaded.</p>
                  <ul>
                    {recent.map((r) => (
                      <li key={r.row.id}>
                        <details>
                          <summary>
                            <code>{r.row.event_type}</code>
                            {r.row.target && <span className="muted"> · {r.row.target}</span>}
                            <span className={`recent-status ${r.status}`}>{r.status}</span>
                            <span className="muted small recent-time">{new Date(r.row.occurred_at).toLocaleTimeString()}</span>
                          </summary>
                          <pre>{JSON.stringify(r.row, null, 2)}</pre>
                        </details>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}

          <h3>Delete my data</h3>
          <p className="muted small">
            Removes every research event stored for your account on HumanStudy Hub, and clears the events waiting
            on this computer. This cannot be undone. Your choices above stay as they are.
          </p>
          {confirmDelete ? (
            <div className="row-end">
              <span className="small">Delete all research data for this account?</span>
              <button className="ghost" disabled={Boolean(busy)} onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
              <button className="primary danger-fill" disabled={Boolean(busy)} onClick={() => void del()}>
                {busy === 'delete' ? 'Deleting…' : 'Delete everything'}
              </button>
            </div>
          ) : (
            <button className="ghost danger" disabled={Boolean(busy)} onClick={() => setConfirmDelete(true)}>
              Delete my data…
            </button>
          )}
        </>
      )}
    </section>
  )
}
