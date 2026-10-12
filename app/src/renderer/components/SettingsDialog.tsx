import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ProviderStatus, Settings } from '../../preload/types'

interface Props {
  settings: Settings | null
  onChange(patch: Partial<Settings>): void
  onClose(): void
}

type Section = 'general' | 'models'
const MODEL_SUGGESTIONS = ['anthropic/claude-haiku-5.5', 'anthropic/claude-sonnet-5.5', 'deepseek/deepseek-chat']

export function SettingsDialog({ settings, onChange, onClose }: Props) {
  const [section, setSection] = useState<Section>('general')
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
      <div className="settings" role="dialog" aria-modal="true" aria-label="Settings" tabIndex={-1} ref={dialog}>
        <nav className="settings-nav">
          <strong className="settings-title">Settings</strong>
          {(['general', 'models'] as Section[]).map((s) => (
            <button key={s} aria-current={section === s ? 'page' : undefined} onClick={() => setSection(s)}>
              {s === 'general' ? 'General' : 'Models'}
            </button>
          ))}
        </nav>
        <div className="settings-body">
          <button className="ghost settings-close" aria-label="Close settings" title="Close (Esc)" onClick={onClose}>
            ×
          </button>
          {!settings ? (
            <p className="muted">Loading…</p>
          ) : section === 'general' ? (
            <General settings={settings} onChange={onChange} />
          ) : (
            <Models settings={settings} onChange={onChange} />
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
      <h2>General</h2>
      <Row label="Appearance">
        <Segmented
          label="Appearance"
          value={settings.theme}
          options={[
            ['light', 'Light'],
            ['dark', 'Dark'],
            ['system', 'System'],
          ]}
          onChange={(theme) => onChange({ theme })}
        />
      </Row>
      <Row label="Enter while the agent is running" hint="What pressing Enter does with a new message mid-run.">
        <Segmented
          label="Enter while the agent is running"
          value={settings.busyEnter}
          options={[
            ['queue', 'Queue message'],
            ['interrupt', 'Interrupt'],
          ]}
          onChange={(busyEnter) => onChange({ busyEnter })}
        />
      </Row>
      <Row label="Default permission" hint="Applies to new agent sessions.">
        <Segmented
          label="Default permission"
          value={settings.permission}
          options={[
            ['ask', 'Ask before commands'],
            ['project', 'Allow inside the project'],
          ]}
          onChange={(permission) => onChange({ permission })}
        />
      </Row>
      <Row label="Projects folder" hint="Where new projects are created.">
        <code className="path" title={settings.projectsRoot}>
          {settings.projectsRoot}
        </code>
      </Row>
    </section>
  )
}

function Models({ settings, onChange }: { settings: Settings; onChange(p: Partial<Settings>): void }) {
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
    <section>
      <h2>Models</h2>
      <p className="muted settings-lead">Add an API key for a provider to use its models.</p>
      {error && <p className="home-error">{error}</p>}
      <ul className="provider-list">
        {(providers ?? []).map((p) => (
          <li key={p.id}>
            <div className="provider-head">
              <div>
                <div className="setting-label">{p.label}</div>
                {p.configured ? (
                  <span className="status-ok small">
                    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden>
                      <path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    Key configured
                  </span>
                ) : (
                  <span className="muted small">Not configured</span>
                )}
              </div>
              {editing !== p.id && (
                <div className="provider-actions">
                  <button
                    className="ghost"
                    onClick={() => {
                      setEditing(p.id)
                      setKey('')
                    }}
                  >
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
                <input
                  autoFocus
                  type="password"
                  className="field"
                  placeholder={`${p.label} API key`}
                  value={key}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setKey(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.stopPropagation()
                      e.nativeEvent.stopImmediatePropagation()
                      setEditing(null)
                    }
                  }}
                />
                <button type="button" className="ghost" onClick={() => setEditing(null)}>
                  Cancel
                </button>
                <button type="submit" className="primary" disabled={!key.trim()}>
                  Save
                </button>
              </form>
            )}
          </li>
        ))}
        {providers === null && !error && <li className="muted small">Loading…</li>}
      </ul>
      <p className="muted small">Keys are stored encrypted with the macOS keychain and never leave this machine except to call the provider.</p>

      <h3>Default model</h3>
      <form
        className="key-form"
        onSubmit={(e) => {
          e.preventDefault()
          saveModel()
        }}
      >
        <input
          className="field"
          list="model-suggestions"
          value={model}
          spellCheck={false}
          onChange={(e) => setModel(e.target.value)}
          onBlur={saveModel}
          aria-label="Default model"
        />
        <datalist id="model-suggestions">
          {MODEL_SUGGESTIONS.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        <button type="submit" className="primary" disabled={!model.trim() || model.trim() === settings.model}>
          Save
        </button>
      </form>
      <div className="suggest-row">
        {MODEL_SUGGESTIONS.map((m) => (
          <button
            key={m}
            className={`chip-btn ${settings.model === m ? 'on' : ''}`}
            onClick={() => {
              setModel(m)
              onChange({ model: m })
            }}
          >
            {m}
          </button>
        ))}
      </div>
    </section>
  )
}
