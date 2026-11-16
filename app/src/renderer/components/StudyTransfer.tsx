// "Download this study" (a small dialog: what goes in, how large) and the notice shown while a downloaded study opens
// or when it cannot. The work happens in the main process (src/main/study-transfer.ts); on the web edition the save
// becomes a browser download and the picked or dropped file is uploaded first (web/browser-electron.ts).
import { useEffect, useMemo, useRef, useState } from 'react'
import type { StudyExportPreview, StudyTransferFailure } from '../../preload/types'
import { t } from '../i18n'
import { WEB_EDITION } from '../edition'
import { errorText } from './SettingsDialog'

/** "830 bytes", "12.4 MB" (decimal units, as Finder and Explorer show file sizes). */
export function formatBytes(n: number): string {
  if (n < 1000) return `${n} B`
  const units = ['KB', 'MB', 'GB']
  let v = n / 1000
  let i = 0
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++ }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, '')} ${units[i]}`
}

/** The plain sentence for a failure; never shows the internal reason (file lists, checksums, zip details). */
export function transferErrorText(r: StudyTransferFailure, kind: 'import' | 'export'): string {
  const file = r.file ?? ''
  const key = kind === 'export' && (r.code === 'too-large' || r.code === 'unsafe') ? `transfer.err_export_${r.code}` : `transfer.err_${r.code}`
  const text = t(key, { file, detail: r.detail ?? '' })
  // A reason about one file without a file name reads better without the empty brackets.
  return file ? text : text.replace(/\s*[（(]\s*[）)]/, '')
}

/** True for a file that looks like a downloaded study (the dropped file's own name; online it is uploaded later). */
export const isStudyFile = (name: string): boolean => /\.zip$/i.test(name)

export function ExportStudyDialog({ dir, onClose }: { dir: string; onClose(): void }) {
  const [preview, setPreview] = useState<StudyExportPreview | null>(null)
  const [conversations, setConversations] = useState(true)
  const [ticked, setTicked] = useState<Set<string>>(() => new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    box.current?.focus()
    let live = true
    window.humanstudy.projects.exportPreview(dir).then(
      (p) => { if (live) setPreview(p) },
      (e: unknown) => { if (live) setError(errorText(e, t('transfer.err_not-project'))) },
    )
    return () => { live = false }
  }, [dir])
  useEffect(() => {
    const keys = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) { e.preventDefault(); onClose() } }
    window.addEventListener('keydown', keys)
    return () => window.removeEventListener('keydown', keys)
  }, [busy, onClose])

  const size = useMemo(() => {
    if (!preview) return { bytes: 0, files: 0 }
    const priv = preview.privateFiles.filter((f) => ticked.has(f.path))
    return {
      bytes: preview.study.bytes + (conversations ? preview.conversations.bytes : 0) + priv.reduce((n, f) => n + f.bytes, 0),
      files: preview.study.files + (conversations ? preview.conversations.files : 0) + priv.length,
    }
  }, [preview, conversations, ticked])
  const tooBig = Boolean(preview && (size.bytes > preview.limits.maxTotalBytes || size.files > preview.limits.maxFiles))

  const save = async () => {
    if (!preview || busy) return
    setBusy(true)
    setError('')
    try {
      const r = await window.humanstudy.projects.exportStudy(dir, { conversations, privateFiles: [...ticked] })
      if (!r) return // the save dialog was cancelled
      if (!r.ok) return setError(transferErrorText(r, 'export'))
      setSaved(r.savedPath.split(/[\\/]/).pop() || r.savedPath)
    } catch (e) {
      setError(errorText(e, t('transfer.err_export_title')))
    } finally {
      setBusy(false)
    }
  }
  const toggle = (path: string) =>
    setTicked((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  return (
    <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div className="consent-dialog transfer-dialog" role="dialog" aria-modal="true" aria-label={t('transfer.download')} tabIndex={-1} ref={box}>
        <h2>{t('transfer.download')}</h2>
        {saved ? (
          <>
            <p className="transfer-text">{t(WEB_EDITION ? 'transfer.saved_web' : 'transfer.saved', { name: saved })}</p>
            <div className="row-end">
              <button className="primary" autoFocus onClick={onClose}>{t('transfer.done')}</button>
            </div>
          </>
        ) : (
          <>
            <p className="transfer-text muted">{t('transfer.intro')}</p>
            {!preview && !error && <p className="muted small">{t('transfer.preparing')}</p>}
            {preview && (
              <>
                <h3 className="transfer-label">{t('transfer.included')}</h3>
                <ul className="transfer-list">
                  <li>
                    <input type="checkbox" checked disabled aria-hidden />
                    <span>{t(preview.hasPaper ? 'transfer.study_files_paper' : 'transfer.study_files', { n: preview.study.files })}</span>
                    <span className="muted small">{formatBytes(preview.study.bytes)}</span>
                  </li>
                  {preview.conversations.count > 0 && (
                    <li>
                      <label>
                        <input type="checkbox" checked={conversations} disabled={busy} onChange={(e) => setConversations(e.target.checked)} />
                        <span>
                          {preview.conversations.count === 1 ? t('transfer.conversations_one') : t('transfer.conversations', { n: preview.conversations.count })}
                          <span className="muted small transfer-hint">{t('transfer.conversations_hint')}</span>
                        </span>
                      </label>
                      <span className="muted small">{formatBytes(preview.conversations.bytes)}</span>
                    </li>
                  )}
                </ul>
                {preview.privateFiles.length > 0 && (
                  <>
                    <h3 className="transfer-label">{t('transfer.private')}</h3>
                    <p className="muted small transfer-hint">{t('transfer.private_hint')}</p>
                    <ul className="transfer-list private">
                      {preview.privateFiles.map((f) => (
                        <li key={f.path}>
                          <label title={f.path}>
                            <input type="checkbox" checked={ticked.has(f.path)} disabled={busy} onChange={() => toggle(f.path)} />
                            <span className="transfer-file">{f.path.replace(/^sources\/(?:private|researcher|quarantine)\//i, '')}</span>
                          </label>
                          <span className="muted small">{formatBytes(f.bytes)}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                <p className="small transfer-size">
                  {t('transfer.size', { size: formatBytes(size.bytes) })}
                  <span className="muted"> · {t('transfer.never')}</span>
                </p>
                {tooBig && <p className="home-error">{t('transfer.too_big', { limit: formatBytes(preview.limits.maxTotalBytes) })}</p>}
              </>
            )}
            {error && <p className="home-error">{error}</p>}
            <div className="row-end">
              <button className="ghost" onClick={onClose} disabled={busy}>{t('home.cancel')}</button>
              <button className="primary" onClick={() => void save()} disabled={!preview || busy || tooBig}>
                {busy ? t('transfer.saving') : t('transfer.save')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/** While a downloaded study opens, and when it cannot (or a menu action needs a project first). */
export function TransferNotice({ busy, title, message, onClose }: { busy: boolean; title?: string; message: string; onClose(): void }) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => box.current?.focus(), [])
  useEffect(() => {
    if (busy) return
    const keys = (e: KeyboardEvent) => { if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); onClose() } }
    window.addEventListener('keydown', keys)
    return () => window.removeEventListener('keydown', keys)
  }, [busy, onClose])
  return (
    <div className="overlay">
      <div className="consent-dialog transfer-dialog" role={busy ? 'status' : 'alertdialog'} aria-modal="true" aria-label={title ?? message} tabIndex={-1} ref={box}>
        {title && <h2>{title}</h2>}
        <p className="transfer-text">{message}</p>
        {!busy && (
          <div className="row-end">
            <button className="primary" onClick={onClose}>{t('transfer.done')}</button>
          </div>
        )}
      </div>
    </div>
  )
}
