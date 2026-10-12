import { useEffect, useState } from 'react'
import type { UpdateStatus } from '../../preload/types'
import './updates.css'

/** Live update status from the main process (electron-updater). */
export function useUpdateStatus(): UpdateStatus | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  useEffect(() => {
    const api = window.humanstudy.updates
    if (!api) return
    let live = true
    api.status().then((s) => live && setStatus(s)).catch(() => undefined)
    const off = api.onChange(setStatus)
    return () => {
      live = false
      off()
    }
  }, [])
  return status
}

/** A quiet corner notice once an update has been downloaded. Dismissable until the next launch. */
export function UpdateNotice() {
  const status = useUpdateStatus()
  const [dismissed, setDismissed] = useState<string | null>(null)
  if (!status || status.state !== 'ready' || dismissed === (status.nextVersion ?? '')) return null
  return (
    <div className="update-notice" role="status">
      <span className="update-dot" aria-hidden />
      <span>
        Update ready — restart to install
        {status.nextVersion && <span className="muted"> · {status.nextVersion}</span>}
      </span>
      <button className="primary" onClick={() => void window.humanstudy.updates.install()}>
        Restart
      </button>
      <button className="ghost" aria-label="Later" title="Later" onClick={() => setDismissed(status.nextVersion ?? '')}>
        Later
      </button>
    </div>
  )
}

function stateLine(s: UpdateStatus): string {
  switch (s.state) {
    case 'checking':
      return 'Checking for updates…'
    case 'available':
      return `Version ${s.nextVersion ?? ''} is available; downloading in the background.`
    case 'downloading':
      return `Downloading ${s.nextVersion ?? 'update'}${s.progress != null ? ` · ${s.progress}%` : ''}`
    case 'ready':
      return `Version ${s.nextVersion ?? ''} is ready. Restart to install.`
    case 'none':
      return 'You are up to date.'
    case 'error':
      return `Could not check for updates${s.error ? `: ${s.error.split('\n')[0]}` : '.'}`
    default:
      return 'Updates are checked automatically every few hours.'
  }
}

/** The "About & updates" section of Settings. */
export function AboutUpdates() {
  const status = useUpdateStatus()
  const busy = status?.state === 'checking' || status?.state === 'downloading'
  return (
    <section>
      <h2>About &amp; updates</h2>
      <div className="setting-row">
        <div>
          <div className="setting-label">HumanStudy Hub</div>
          <div className="muted small">Version {status?.version ?? '…'}</div>
        </div>
        <div className="setting-control">
          {status?.state === 'ready' ? (
            <button className="primary" onClick={() => void window.humanstudy.updates.install()}>
              Restart to install
            </button>
          ) : (
            <button className="ghost" disabled={busy} onClick={() => void window.humanstudy.updates.check()}>
              {status?.state === 'checking' ? 'Checking…' : 'Check for updates'}
            </button>
          )}
        </div>
      </div>
      {status && (
        <p className={`small update-line ${status.state === 'error' ? 'error' : 'muted'}`} role="status">
          {stateLine(status)}
        </p>
      )}
      {status?.state === 'downloading' && status.progress != null && (
        <div className="update-bar" aria-hidden>
          <span style={{ width: `${status.progress}%` }} />
        </div>
      )}
    </section>
  )
}
