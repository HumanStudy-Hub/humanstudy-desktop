import { useEffect, useState, type FormEvent } from 'react'
import type { AccountStatus, AppInfo, SupportStatus } from '../../preload/types'
import { t } from '../i18n'

const newId = () => crypto.randomUUID()

export function HelpFeedback({ account }: { account: AccountStatus | null }) {
  const [status, setStatus] = useState<SupportStatus | null>(null)
  const [kind, setKind] = useState<'help' | 'problem' | 'suggestion'>('help')
  const [message, setMessage] = useState('')
  const [replyEmail, setReplyEmail] = useState(account?.email ?? '')
  const [includeDiagnostics, setIncludeDiagnostics] = useState(false)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [id, setId] = useState(newId)
  const [receipt, setReceipt] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.humanstudy.support.status().then(setStatus).catch(() => setStatus({ available: false }))
    void window.humanstudy.app.info().then(setInfo).catch(() => setInfo(null))
  }, [account?.signedIn, account?.email])
  useEffect(() => { if (!replyEmail && account?.email) setReplyEmail(account.email) }, [account?.email])

  const emailValid = !replyEmail.trim() || (replyEmail.trim().length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(replyEmail.trim()))
  const canSubmit = Boolean(account?.signedIn && status?.available && !busy && (!includeDiagnostics || info))
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (message.length > 12000) { setError(t('help.err_length')); return }
    if (!message.trim()) { setError(t('help.err_empty')); return }
    if (!emailValid) { setError(t('help.err_email')); return }
    if (includeDiagnostics && !info) { setError(t('common.loading')); return }
    if (!account?.signedIn || !status?.available) return
    setBusy(true); setError('')
    try {
      const result = await window.humanstudy.support.submit({
        id, kind, message, replyEmail: replyEmail.trim() || undefined, includeDiagnostics,
      })
      setReceipt(result.id)
      setMessage(''); setId(newId())
    } catch (err) {
      const detail = err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '') : ''
      setError(detail || t('help.err_submit'))
    } finally { setBusy(false) }
  }

  return <section className="help-feedback">
    <h2>{t('settings.help')}</h2>
    <p className="muted settings-lead">{t('help.lead')}</p>
    {receipt && <p className="account-notice" role="status">{t('help.received', { id: receipt })}{replyEmail.trim() ? ` ${t('help.reply_by_email')}` : ''}</p>}
    {error && <p className="home-error" role="alert">{error}</p>}
    <form className="help-form" onSubmit={submit}>
      <label>
        <span className="setting-label">{t('help.kind')}</span>
        <select className="help-control" disabled={busy} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          <option value="help">{t('help.kind_help')}</option>
          <option value="problem">{t('help.kind_problem')}</option>
          <option value="suggestion">{t('help.kind_suggestion')}</option>
        </select>
      </label>
      <label>
        <span className="setting-label">{t('help.message')}</span>
        <textarea className="help-control help-message" data-private disabled={busy} value={message} onChange={(e) => { setMessage(e.target.value); if (receipt) setReceipt('') }} aria-describedby="help-message-hint help-message-count" />
        <span id="help-message-hint" className="muted small">{t('help.message_hint')}</span>
        <span id="help-message-count" className={`muted small ${message.length > 12000 ? 'help-over-limit' : ''}`} aria-live="polite">{t('help.char_count', { count: message.length })}</span>
      </label>
      <label>
        <span className="setting-label">{t('help.reply_email')}</span>
        <input className="field" type="email" data-private disabled={busy} autoComplete="email" value={replyEmail} onChange={(e) => setReplyEmail(e.target.value)} />
      </label>
      <label className="help-check">
        <input type="checkbox" disabled={busy} checked={includeDiagnostics} onChange={(e) => setIncludeDiagnostics(e.target.checked)} />
        <span><span className="setting-label">{t('help.include_diagnostics')}</span><span className="muted small">{t('help.diagnostics_hint')}</span></span>
      </label>
      {includeDiagnostics && <div className="help-preview" aria-label={t('help.diagnostics_preview_label')}>
        <div className="setting-label">{t('help.diagnostics_preview_label')}</div>
        {info ? <code>{t('help.diagnostics_preview', { version: info.version, platform: info.platform, arch: info.arch })}</code> : <span className="muted small">{t('common.loading')}</span>}
      </div>}
      {(!account?.signedIn || status?.available === false) ? (
        status?.contactEmail ? <p className="muted">{t('help.contact')} <a href={`mailto:${status.contactEmail}`} target="_blank" rel="noreferrer">{status.contactEmail}</a></p> : <p className="muted">{t('help.unavailable')}</p>
      ) : null}
      {message.length > 12000 && <p className="home-error" role="alert">{t('help.err_length')}</p>}
      {replyEmail.trim() && !emailValid && <p className="home-error">{t('help.err_email')}</p>}
      <div className="row-end">
        <button type="submit" className="primary" disabled={!canSubmit}>{busy ? t('help.sending') : t('help.send')}</button>
      </div>
    </form>
  </section>
}
