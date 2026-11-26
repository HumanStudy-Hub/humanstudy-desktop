// "Download this study" (a small dialog: what goes in, how large) and the notice shown while a downloaded study opens
// or when it cannot. The work happens in the main process (src/main/study-transfer.ts); on the web edition the save
// becomes a browser download and the picked or dropped file is uploaded first (web/browser-electron.ts).
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ShareLayer, ShareLayerState, SharePreview, ShareResult, StudyExportPreview, StudyTransferFailure } from '../../preload/types'
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

/** Why the runnable experiment (layer 2) cannot be shared, in plain words; the exporter's own sentence otherwise. */
export function layerReason(state: ShareLayerState): string {
  if (state.code && state.code !== 'blocked') return t(`share.why_${state.code}`)
  return state.reason || t('share.why_blocked')
}

export function shareErrorText(r: Extract<ShareResult, { ok: false }>): string {
  if (r.code === 'runtime') return t('share.why_runtime')
  if (r.code === 'not-project') return t('transfer.err_not-project')
  return r.detail ? t('share.err_detail', { detail: r.detail }) : t('share.err')
}

/** Sharing in three layers: the study overview, the runnable experiment, and ticked results and materials. */
function ShareChoices({ dir, busy, setBusy, onSaved, onCancel }: { dir: string; busy: boolean; setBusy(b: boolean): void; onSaved(name: string): void; onCancel(): void }) {
  const [plan, setPlan] = useState<SharePreview | null>(null)
  const [layer, setLayer] = useState<ShareLayer>('overview')
  const [ticked, setTicked] = useState<Set<string>>(() => new Set())
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    window.humanstudy.projects.sharePreview(dir).then(
      (p) => { if (live) setPlan(p) },
      (e: unknown) => { if (live) setError(errorText(e, t('share.err'))) },
    )
    return () => { live = false }
  }, [dir])
  const chosen = plan ? (layer === 'experiment' && plan.experiment.available ? plan.experiment : plan.overview) : null
  const files = useMemo(() => {
    if (!plan || !chosen) return []
    const extra = plan.results.filter((r) => ticked.has(r.id)).flatMap((r) => r.files)
    return [...chosen.files, ...extra].sort()
  }, [plan, chosen, ticked])
  const toggle = (id: string, on: boolean) => setTicked((prev) => {
    const next = new Set(prev)
    if (on) next.add(id); else next.delete(id)
    return next
  })
  const save = async () => {
    if (!plan || !chosen?.available || busy) return
    setBusy(true)
    setError('')
    try {
      const r = await window.humanstudy.projects.shareStudy(dir, { layer: layer === 'experiment' && plan.experiment.available ? 'experiment' : 'overview', results: [...ticked] })
      if (!r) return
      if (!r.ok) return setError(shareErrorText(r))
      onSaved(r.savedPath.split(/[\\/]/).pop() || r.savedPath)
    } catch (e) {
      setError(errorText(e, t('share.err')))
    } finally {
      setBusy(false)
    }
  }
  const resultName = (id: string, kind: string) => kind === 'trial' ? t('share.trial', { name: id.split('/').pop() ?? id }) : id.replace(/^artifacts\//, '')
  return (
    <>
      <p className="transfer-text muted">{t('share.intro')}</p>
      {!plan && !error && <p className="muted small">{t('transfer.preparing')}</p>}
      {plan && (
        <>
          <div className="consent-choices" role="radiogroup" aria-label={t('share.layers')}>
            <label className="consent-choice">
              <input type="radio" name="share-layer" checked={layer === 'overview'} disabled={busy || !plan.overview.available} onChange={() => setLayer('overview')} />
              <span>
                <strong>{t('share.overview')}</strong>
                <span className="muted small">{t('share.overview_includes')}</span>
                {plan.overview.available && (plan.overview.withheld ?? 0) > 0 && <span className="muted small">{t('share.withheld', { n: plan.overview.withheld ?? 0 })}</span>}
                {!plan.overview.available && <span className="small home-error">{layerReason(plan.overview)}</span>}
              </span>
            </label>
            <label className="consent-choice">
              <input type="radio" name="share-layer" checked={layer === 'experiment' && plan.experiment.available} disabled={busy || !plan.experiment.available} onChange={() => setLayer('experiment')} />
              <span>
                <strong>{t('share.experiment')}</strong>
                <span className="muted small">{t('share.experiment_includes')}</span>
                {plan.experiment.available
                  ? <span className="muted small">{t(plan.experiment.validated === 'library' ? 'share.validated' : 'share.checked')}</span>
                  : <span className="small">{layerReason(plan.experiment)}</span>}
              </span>
            </label>
          </div>
          <h3 className="transfer-label">{t('share.results')}</h3>
          <p className="muted small transfer-hint">{t('share.results_hint')}</p>
          {plan.results.length === 0 ? <p className="muted small">{t('share.results_none')}</p> : (
            <ul className="transfer-list private">
              {plan.results.map((r) => (
                <li key={r.id}>
                  <label>
                    <input type="checkbox" checked={ticked.has(r.id)} disabled={busy || Boolean(r.blocked)} onChange={(e) => toggle(r.id, e.target.checked)} />
                    <span>
                      <span className="transfer-file">{resultName(r.id, r.kind)}</span>
                      {r.blocked && <span className="muted small transfer-hint">{t('share.blocked', { why: r.blocked })}</span>}
                    </span>
                  </label>
                  <span className="muted small">{formatBytes(r.bytes)}</span>
                </li>
              ))}
            </ul>
          )}
          {chosen?.available && (
            <details className="small transfer-size">
              <summary>{t('share.file_list', { n: files.length })}</summary>
              <ul className="transfer-list">
                {files.map((f) => <li key={f}><span className="transfer-file">{f}</span></li>)}
              </ul>
            </details>
          )}
          <p className="small muted transfer-size">{t('share.never')}</p>
        </>
      )}
      {error && <p className="home-error">{error}</p>}
      <div className="row-end">
        <button className="ghost" onClick={onCancel} disabled={busy}>{t('home.cancel')}</button>
        <button className="primary" onClick={() => void save()} disabled={!chosen?.available || busy}>
          {busy ? t('transfer.saving') : t('share.save')}
        </button>
      </div>
    </>
  )
}

export function ExportStudyDialog({ dir, onClose }: { dir: string; onClose(): void }) {
  const [mode, setMode] = useState<'copy' | 'share'>('copy')
  const [preview, setPreview] = useState<StudyExportPreview | null>(null)
  const [conversations, setConversations] = useState(true)
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
    // Private files stay on this computer (study-transfer.ts); only the chat history can be left out.
    return {
      bytes: preview.study.bytes + (conversations ? preview.conversations.bytes : 0),
      files: preview.study.files + (conversations ? preview.conversations.files : 0),
    }
  }, [preview, conversations])
  const tooBig = Boolean(preview && (size.bytes > preview.limits.maxTotalBytes || size.files > preview.limits.maxFiles))

  const save = async () => {
    if (!preview || busy) return
    setBusy(true)
    setError('')
    try {
      const r = await window.humanstudy.projects.exportStudy(dir, { conversations })
      if (!r) return // the save dialog was cancelled
      if (!r.ok) return setError(transferErrorText(r, 'export'))
      setSaved(r.savedPath.split(/[\\/]/).pop() || r.savedPath)
    } catch (e) {
      setError(errorText(e, t('transfer.err_export_title')))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div className="consent-dialog transfer-dialog" role="dialog" aria-modal="true" aria-label={t('transfer.download')} tabIndex={-1} ref={box}>
        <h2>{t('transfer.download')}</h2>
        {!saved && (
          <div className="consent-choices" role="radiogroup" aria-label={t('share.mode')}>
            <label className="consent-choice">
              <input type="radio" name="transfer-mode" checked={mode === 'copy'} disabled={busy} onChange={() => setMode('copy')} />
              <span><strong>{t('share.mode_copy')}</strong><span className="muted small">{t('share.mode_copy_hint')}</span></span>
            </label>
            <label className="consent-choice">
              <input type="radio" name="transfer-mode" checked={mode === 'share'} disabled={busy} onChange={() => setMode('share')} />
              <span><strong>{t('share.mode_share')}</strong><span className="muted small">{t('share.mode_share_hint')}</span></span>
            </label>
          </div>
        )}
        {saved ? (
          <>
            <p className="transfer-text">{mode === 'share' ? t(WEB_EDITION ? 'share.saved_web' : 'share.saved', { name: saved }) : t(WEB_EDITION ? 'transfer.saved_web' : 'transfer.saved', { name: saved })}</p>
            <div className="row-end">
              <button className="primary" autoFocus onClick={onClose}>{t('transfer.done')}</button>
            </div>
          </>
        ) : mode === 'share' ? (
          <ShareChoices dir={dir} busy={busy} setBusy={setBusy} onSaved={setSaved} onCancel={onClose} />
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
                  {preview.privateFiles.length > 0 && (
                    <li>
                      <input type="checkbox" checked={false} disabled aria-hidden />
                      <span>
                        {t(preview.privateFiles.length === 1 ? 'transfer.private_one' : 'transfer.private_n', { n: preview.privateFiles.length })}
                        <span className="muted small transfer-hint">{t('transfer.private_hint')}</span>
                      </span>
                      <span className="muted small">{formatBytes(preview.privateFiles.reduce((n, f) => n + f.bytes, 0))}</span>
                    </li>
                  )}
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
