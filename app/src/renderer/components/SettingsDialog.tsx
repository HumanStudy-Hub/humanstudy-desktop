import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AccountStatus, ProviderStatus, Settings } from '../../preload/types'
import { AboutUpdates } from './Updates'
import { ResearchDataSection } from './ResearchData'
import { track } from '../telemetry'
import { t, getLangPref, setLangPref, type LangPref } from '../i18n'

export type SettingsSection = 'account' | 'general' | 'models' | 'research' | 'about'

interface Props {
  initialSection?: SettingsSection | null
  settings: Settings | null
  onChange(patch: Partial<Settings>): void
  account: AccountStatus | null
  onAccount(status: AccountStatus): void
  onClose(): void
  /** Hidden developer path (HUMANSTUDY_DEV_KEYS=1): own provider keys. */
  devKeys?: boolean
  onReviewAgreement(): void
}

type Section = SettingsSection
const sectionLabel = (s: Section) => t('settings.' + s)

/** Electron prefixes errors from ipcMain handlers; show only the message the main process wrote. */
export function errorText(e: unknown, fallback: string): string {
  const msg = e instanceof Error ? e.message : ''
  return msg.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '') || fallback
}
const MODELS: [string, string, string][] = [
  ['anthropic/claude-sonnet-5.5', 'Claude Sonnet 5.5', 'settings.model_sonnet'],
  ['anthropic/claude-haiku-5.5', 'Claude Haiku 5.5', 'settings.model_haiku'],
  ['deepseek/deepseek-v4.1-flash', 'DeepSeek V4.1 Flash', 'settings.model_deepseek'],
]

export function SettingsDialog({ initialSection, settings, onChange, account, onAccount, onClose, devKeys, onReviewAgreement }: Props) {
  const [section, setSection] = useState<Section>(initialSection ?? 'general')
  const dialog = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const keys = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', keys)
    dialog.current?.focus()
    return () => window.removeEventListener('keydown', keys)
  }, [onClose])

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="settings" role="dialog" aria-modal="true" aria-label={t('settings.title')} tabIndex={-1} ref={dialog}>
        <nav className="settings-nav">
          <strong className="settings-title">{t('settings.title')}</strong>
          {(['account', 'general', 'models', 'research', 'about'] as Section[]).map((s) => (
            <button
              key={s}
              aria-current={section === s ? 'page' : undefined}
              onClick={() => {
                setSection(s)
                track('settings.section', { target: s })
              }}
            >
              {sectionLabel(s)}
            </button>
          ))}
        </nav>
        <div className="settings-body">
          <button className="ghost settings-close" aria-label={t('settings.close')} title={t('settings.close_hint')} onClick={onClose}>
            ×
          </button>
          {section === 'account' ? (
            <Account account={account} onAccount={onAccount} />
          ) : section === 'about' ? (
            <AboutUpdates />
          ) : section === 'research' ? (
            <ResearchDataSection onReview={onReviewAgreement} />
          ) : !settings ? (
            <p className="muted">{t('common.loading')}</p>
          ) : section === 'general' ? (
            <General settings={settings} onChange={onChange} />
          ) : (
            <Models settings={settings} onChange={onChange} account={account} devKeys={Boolean(devKeys)} />
          )}
        </div>
      </div>
    </div>
  )
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="setting-row">
      <div>
        <div className="setting-label">{label}</div>
        {hint && <div className="muted small">{hint}</div>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  )
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T
  options: [T, string][]
  onChange(v: T): void
  label: string
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} role="radio" aria-checked={value === v} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  )
}

function General({ settings, onChange }: { settings: Settings; onChange(p: Partial<Settings>): void }) {
  return (
    <section>
      <h2>{t('settings.general')}</h2>
      <Row label={t('settings.appearance')}>
        <Segmented
          label={t('settings.appearance')}
          value={settings.theme}
          options={[
            ['light', t('settings.light')],
            ['dark', t('settings.dark')],
            ['system', t('settings.system')],
          ]}
          onChange={(theme) => onChange({ theme })}
        />
      </Row>
      <Row label={t('settings.language')} hint={t('settings.language_hint')}>
        <Segmented
          label={t('settings.language')}
          value={getLangPref()}
          options={[
            ['system', t('settings.lang_system')],
            ['en', 'English'],
            ['zh-CN', '中文'],
          ] as [LangPref, string][]}
          onChange={(l) => {
            track('settings.language', { target: l })
            setLangPref(l)
          }}
        />
      </Row>
      <Row label={t('settings.busy_enter')} hint={t('settings.busy_enter_hint')}>
        <Segmented
          label={t('settings.busy_enter')}
          value={settings.busyEnter}
          options={[
            ['queue', t('settings.queue')],
            ['interrupt', t('settings.interrupt')],
          ]}
          onChange={(busyEnter) => onChange({ busyEnter })}
        />
      </Row>
      <Row label={t('settings.permission')} hint={t('settings.permission_hint')}>
        <Segmented
          label={t('settings.permission')}
          value={settings.permission}
          options={[
            ['ask', t('settings.perm_ask')],
            ['project', t('settings.perm_project')],
          ]}
          onChange={(permission) => onChange({ permission })}
        />
      </Row>
      <Row label={t('settings.notifications')} hint={t('settings.notifications_hint')}>
        <Segmented
          label={t('settings.notifications')}
          value={settings.notifications ? 'on' : 'off'}
          options={[
            ['on', t('settings.on')],
            ['off', t('settings.off')],
          ]}
          onChange={(v) => onChange({ notifications: v === 'on' })}
        />
      </Row>
      <Row label={t('settings.projects_folder')} hint={t('settings.projects_folder_hint')}>
        <code className="path" title={settings.projectsRoot}>
          {settings.projectsRoot}
        </code>
        <button
          className="ghost"
          onClick={() =>
            void window.humanstudy.settings.pickProjectsRoot().then((next) => {
              if (next) onChange({ projectsRoot: next.projectsRoot })
            })
          }
        >
          {t('settings.change')}
        </button>
      </Row>
    </section>
  )
}

function Models({
  settings,
  onChange,
  account,
  devKeys,
}: {
  settings: Settings
  onChange(p: Partial<Settings>): void
  account: AccountStatus | null
  devKeys: boolean
}) {
  const hosted = account?.models?.length ? account.models : null
  const list = hosted ? MODELS.filter(([id]) => hosted.includes(id)) : MODELS
  return (
    <section>
      <h2>{t('settings.models')}</h2>
      <p className="muted settings-lead">{t('settings.models_lead')}</p>
      <h3>{t('settings.default_model')}</h3>
      <div className="model-list" role="radiogroup" aria-label={t('settings.default_model')}>
        {list.map(([id, name, hint]) => (
          <label key={id} className={`model-row ${settings.model === id ? 'on' : ''}`}>
            <input type="radio" name="model" checked={settings.model === id} onChange={() => onChange({ model: id })} />
            <span className="model-name">
              {name}
              {hint && <span className="muted small"> · {t(hint)}</span>}
            </span>
          </label>
        ))}
      </div>
      {devKeys && <DevKeys settings={settings} onChange={onChange} />}
    </section>
  )
}

/** Hidden developer path (HUMANSTUDY_DEV_KEYS=1): own provider keys and a free-form model id. */
function DevKeys({ settings, onChange }: { settings: Settings; onChange(p: Partial<Settings>): void }) {
  const [providers, setProviders] = useState<ProviderStatus[] | null>(null)
  const [editing, setEditing] = useState<ProviderStatus['id'] | null>(null)
  const [key, setKey] = useState('')
  const [error, setError] = useState('')
  const [model, setModel] = useState(settings.model)

  useEffect(() => {
    window.humanstudy.settings
      .providers()
      .then(setProviders)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not load providers.'))
  }, [])
  useEffect(() => setModel(settings.model), [settings.model])

  const saveKey = async (id: ProviderStatus['id'], value: string) => {
    setError('')
    try {
      setProviders(await window.humanstudy.settings.setKey(id, value))
      setEditing(null)
      setKey('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the key.')
    }
  }
  const saveModel = () => {
    const m = model.trim()
    if (m && m !== settings.model) onChange({ model: m })
  }

  return (
    <>
      <h3>Developer: provider keys</h3>
      <p className="muted settings-lead">Hidden developer path. A saved OpenRouter key takes precedence over hosted access.</p>
      {error && <p className="home-error">{error}</p>}
      <ul className="provider-list">
        {(providers ?? []).map((p) => (
          <li key={p.id}>
            <div className="provider-head">
              <div>
                <div className="setting-label">{p.label}</div>
                <span className="muted small">{p.configured ? 'Key configured' : 'Not configured'}</span>
              </div>
              {editing !== p.id && (
                <div className="provider-actions">
                  <button className="ghost" onClick={() => { setEditing(p.id); setKey('') }}>
                    {p.configured ? 'Edit' : 'Add key'}
                  </button>
                  {p.configured && (
                    <button className="ghost danger" onClick={() => void saveKey(p.id, '')}>
                      Remove
                    </button>
                  )}
                </div>
              )}
            </div>
            {editing === p.id && (
              <form
                className="key-form"
                onSubmit={(e) => {
                  e.preventDefault()
                  if (key.trim()) void saveKey(p.id, key.trim())
                }}
              >
                <input autoFocus type="password" className="field" placeholder={`${p.label} API key`} value={key} autoComplete="off" spellCheck={false} onChange={(e) => setKey(e.target.value)} />
                <button type="button" className="ghost" onClick={() => setEditing(null)}>Cancel</button>
                <button type="submit" className="primary" disabled={!key.trim()}>Save</button>
              </form>
            )}
          </li>
        ))}
      </ul>
      <h3>Developer: model id</h3>
      <form className="model-other" onSubmit={(e) => { e.preventDefault(); saveModel() }}>
        <input className="field" value={model} spellCheck={false} placeholder="provider/model-id" onChange={(e) => setModel(e.target.value)} onBlur={saveModel} aria-label="Model id" />
      </form>
    </>
  )
}

function accessLine(a: AccountStatus): string {
  if (a.modelAccess === 'own-key') return t('settings.access_own')
  if (a.modelAccess === 'hosted') {
    const ms = a.keyExpiresAt ? Date.parse(a.keyExpiresAt) : NaN
    const until = Number.isNaN(ms)
      ? ''
      : t('settings.access_until', { date: new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) })
    return `${t('settings.access_hosted')}${until}`
  }
  return t('settings.access_none')
}

function Account({ account, onAccount }: { account: AccountStatus | null; onAccount(a: AccountStatus): void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState<'' | 'signin' | 'signup' | 'signout' | 'unlock'>('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const run = async (kind: Exclude<typeof busy, ''>, task: () => Promise<void>, fallback: string) => {
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
  const signIn = () =>
    run(
      'signin',
      async () => {
        onAccount(await window.humanstudy.account.signIn(email.trim(), password))
        setPassword('')
      },
      t('settings.err_signin')
    )
  const signUp = () =>
    run(
      'signup',
      async () => {
        const r = await window.humanstudy.account.signUp(email.trim(), password)
        setPassword('')
        if (r.needsConfirmation) setNotice(t('settings.confirm_email'))
        else onAccount(await window.humanstudy.account.status())
      },
      t('settings.err_signup')
    )
  const signOut = () =>
    run('signout', async () => onAccount(await window.humanstudy.account.signOut()), t('settings.err_signout'))
  const unlock = () =>
    run(
      'unlock',
      async () => {
        onAccount(await window.humanstudy.account.unlock(code.trim()))
        setCode('')
      },
      t('settings.err_code')
    )

  if (!account)
    return (
      <section>
        <h2>{t('settings.account')}</h2>
        <p className="muted">{t('common.loading')}</p>
      </section>
    )

  return (
    <section>
      <h2>{t('settings.account')}</h2>
      <p className="muted settings-lead">{t('settings.account_lead')}</p>
      {error && <p className="home-error">{error}</p>}
      {notice && <p className="account-notice">{notice}</p>}

      {!account.signedIn ? (
        <form
          className="account-form"
          onSubmit={(e) => {
            e.preventDefault()
            if (email.trim() && password) void signIn()
          }}
        >
          <label>
            <span className="setting-label">{t('settings.email')}</span>
            <input
              className="field"
              type="email"
              autoComplete="email"
              spellCheck={false}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label>
            <span className="setting-label">{t('settings.password')}</span>
            <input
              className="field"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <div className="row-end">
            <button
              type="button"
              className="ghost"
              disabled={Boolean(busy) || !email.trim() || !password}
              onClick={() => void signUp()}
            >
              {busy === 'signup' ? t('settings.creating') : t('settings.create_account')}
            </button>
            <button type="submit" className="primary" disabled={Boolean(busy) || !email.trim() || !password}>
              {busy === 'signin' ? t('settings.signing_in') : t('chat.signin')}
            </button>
          </div>
        </form>
      ) : (
        <>
          <Row label={t('settings.signed_in')} hint={account.email}>
            <button className="ghost" onClick={() => void signOut()} disabled={Boolean(busy)}>
              {busy === 'signout' ? t('settings.signing_out') : t('settings.sign_out')}
            </button>
          </Row>
          {!account.unlocked && (
            <div className="unlock-box">
              <div className="setting-label">{t('settings.enter_code')}</div>
              <div className="muted small">{t('settings.code_hint')}</div>
              <form
                className="key-form"
                onSubmit={(e) => {
                  e.preventDefault()
                  if (code.trim()) void unlock()
                }}
              >
                <input
                  className="field"
                  placeholder={t('settings.code_placeholder')}
                  autoComplete="off"
                  spellCheck={false}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  aria-label={t('settings.code_placeholder')}
                />
                <button type="submit" className="primary" disabled={Boolean(busy) || !code.trim()}>
                  {busy === 'unlock' ? t('settings.unlocking') : t('settings.unlock')}
                </button>
              </form>
            </div>
          )}
        </>
      )}

      <div className="access-line">
        <span className={`access-dot ${account.modelAccess}`} aria-hidden />
        <span>
          <span className="muted">{t('settings.model_access')}</span>
          {accessLine(account)}
        </span>
      </div>
    </section>
  )
}
