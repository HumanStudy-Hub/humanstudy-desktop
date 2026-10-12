// Research data: the mandatory research data agreement dialog and the Settings → Research data section.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { TelemetryRecent, TelemetryStatus } from '../../preload/types'
import { t } from '../i18n'

/** Electron prefixes errors from ipcMain handlers; show only the message the main process wrote. */
function errorText(e: unknown, fallback: string): string {
  const msg = e instanceof Error ? e.message : ''
  return msg.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '') || fallback
}

export function AgreementText() {
  return (
    <div className="consent-text">
      <p>{t('agree.intro')}</p>
      <ul>
        <li>{t('agree.i1')}</li>
        <li>{t('agree.i2')}</li>
        <li>{t('agree.i3')}</li>
        <li>{t('agree.i4')}</li>
      </ul>
      <p>
        <strong>{t('agree.nopdf')}</strong> {t('agree.stored')}
      </p>
      <p>{t('agree.delete')}</p>
    </div>
  )
}

/** Shown right after sign-in and before any agent use. One choice: agree, or keep the agent locked. */
export function AgreementDialog({ onDone }: { onDone(s: TelemetryStatus): void }) {
  const [busy, setBusy] = useState<'' | 'agree' | 'decline'>('')
  const [error, setError] = useState('')
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => box.current?.focus(), [])

  const save = async (agree: boolean) => {
    setBusy(agree ? 'agree' : 'decline')
    setError('')
    try {
      onDone(await window.humanstudy.telemetry.setConsent({ usage: agree, content: agree }))
    } catch (e) {
      setError(errorText(e, t('agree.err')))
      setBusy('')
    }
  }

  return (
    <div className="overlay">
      <div className="consent-dialog" role="dialog" aria-modal="true" aria-label={t('agree.title')} tabIndex={-1} ref={box}>
        <h2>{t('agree.title')}</h2>
        <AgreementText />
        {error && <p className="home-error">{error}</p>}
        <div className="row-end">
          <button className="ghost" onClick={() => void save(false)} disabled={Boolean(busy)}>
            {t('agree.not_now')}
          </button>
          <button className="primary" onClick={() => void save(true)} disabled={Boolean(busy)}>
            {busy === 'agree' ? t('agree.saving') : t('agree.agree')}
          </button>
        </div>
        <p className="muted small">{t('agree.note')}</p>
      </div>
    </div>
  )
}

export function ResearchDataSection({ onReview }: { onReview(): void }) {
  const [status, setStatus] = useState<TelemetryStatus | null>(null)
  const [recent, setRecent] = useState<TelemetryRecent[] | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [saved, setSaved] = useState('')

  const apply = useCallback((s: TelemetryStatus) => {
    setStatus(s)
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
    setSaved('')
    try {
      await task()
    } catch (e) {
      setError(errorText(e, fallback))
    } finally {
      setBusy('')
    }
  }
  const exportData = () =>
    run(
      'export',
      async () => {
        const events = await window.humanstudy.telemetry.recent()
        const json = JSON.stringify({ exportedAt: new Date().toISOString(), events }, null, 2)
        const path = await window.humanstudy.telemetry.saveExport(json)
        if (!path) return // cancelled
        setSaved(path)
        setNotice(`Saved ${events.length} events (the local queue and the rows already uploaded).`)
      },
      'Could not export your data.'
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

  const agreed = status.decided && status.usage && status.content
  const current = agreed
    ? `Agreed${status.decidedAt ? ` on ${new Date(status.decidedAt).toLocaleDateString()}` : ''}. The agent is unlocked.`
    : status.decided
      ? 'Not agreed. The agent is locked.'
      : 'Not agreed yet. The agent is locked.'

  return (
    <section>
      <h2>Research data</h2>
      {!status.signedIn ? (
        <p className="muted settings-lead">
          Research data is tied to your HumanStudy Hub account. Sign in under Account; while signed out nothing is
          sent.
        </p>
      ) : (
        <p className="settings-lead">{current}</p>
      )}
      {error && <p className="home-error">{error}</p>}
      {notice && (
        <p className="account-notice">
          {notice}
          {saved && (
            <>
              {' '}
              <span title={saved}>{saved}</span>{' '}
              <button className="link" onClick={() => void window.humanstudy.project.reveal(saved)}>
                Show in Finder
              </button>
            </>
          )}
        </p>
      )}

      <details className="consent-details">
        <summary>What is collected, why, and where it is stored</summary>
        <AgreementText />
      </details>

      {status.signedIn && (
        <>
          <div className="row-end">
            <button className="ghost" disabled={Boolean(busy)} onClick={onReview}>
              Review agreement
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
              <button className="ghost" disabled={Boolean(busy)} onClick={() => void exportData()}>
                {busy === 'export' ? 'Exporting…' : 'Download my data'}
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
            on this computer. This cannot be undone. Your agreement stays as it is.
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
