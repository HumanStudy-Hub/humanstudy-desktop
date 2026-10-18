import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import type { NativeOperation, NativeRequest } from '../../shared/native'
import { NATIVE_MUTATIONS } from '../../shared/native'
const NativeTerminal = lazy(() => import('./NativeTerminal').then((m) => ({ default: m.NativeTerminal })))
import { Markdown } from './Markdown'
export interface NativeView {
  operation: NativeOperation
  title: string
  input?: Record<string, unknown>
  preview?: boolean
  action?: NativeOperation
}
/** Lazy DOM, complete values: large histories/tool outputs are expanded on demand, never clipped. */
export function NativeValue({ value, label = 'Details' }: { value: unknown; label?: string }) {
  const [open, setOpen] = useState(false),
    [count, setCount] = useState(30)
  if (value === null || typeof value !== 'object')
    return <pre className="native-value">{typeof value === 'string' ? value : JSON.stringify(value)}</pre>
  const entries = Object.entries(value)
  return (
    <details className="native-value" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        {label} · {entries.length}
      </summary>
      {open && (
        <div>
          {entries.slice(0, count).map(([key, v]) => (
            <div key={key}>
              <strong>{key}</strong>
              <NativeValue value={v} />
            </div>
          ))}
          {entries.length > count && <button onClick={() => setCount((n) => n + 30)}>Load more</button>}
        </div>
      )}
    </details>
  )
}
const errorText = (e: unknown) => String(e).replace(/^Error: Error invoking remote method '[^']+': Error: /, '')
export function NativePanel({
  view,
  sessionId,
  run,
  onClose,
  onSelected,
}: {
  view: NativeView
  sessionId: string
  run(request: NativeRequest): Promise<unknown>
  onClose(): void
  onSelected?(): void
}) {
  const dialog = useRef<HTMLElement>(null)
  const mounted = useRef(true),
    requestEpoch = useRef(0)
  useEffect(() => {
    mounted.current = true
    const previous = document.activeElement as HTMLElement | null
    const frame = requestAnimationFrame(() => {
      ;(dialog.current?.querySelector('.native-search') as HTMLElement | null)?.focus()
      if (!dialog.current?.contains(document.activeElement))
        (dialog.current?.querySelector('[aria-label="Close"]') as HTMLElement | null)?.focus()
    })
    return () => {
      cancelAnimationFrame(frame)
      mounted.current = false
      requestEpoch.current++
      if (previous?.isConnected) previous.focus()
    }
  }, [])
  const [data, setData] = useState<any>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [query, setQuery] = useState(''),
    [form, setForm] = useState(''),
    [secret, setSecret] = useState(''),
    [provider, setProvider] = useState(''),
    [auth, setAuth] = useState<any>(null),
    [terminal, setTerminal] = useState(''),
    [sharedUrl, setSharedUrl] = useState('')
  const refresh = useCallback(async () => {
    const epoch = ++requestEpoch.current
    setError('')
    setBusy(true)
    try {
      const result =
        ['find', 'symbols'].includes(view.operation) && !Object.values(view.input ?? {}).some(Boolean)
          ? []
          : await run({ operation: view.preview ? 'history' : view.operation, input: view.input })
      if (mounted.current && epoch === requestEpoch.current) setData(result)
    } catch (e) {
      if (mounted.current && epoch === requestEpoch.current) setError(errorText(e))
    } finally {
      if (mounted.current && epoch === requestEpoch.current) setBusy(false)
    }
  }, [view, run])
  useEffect(() => {
    void refresh()
  }, [refresh, sessionId])
  const action = async (operation: NativeOperation, input?: Record<string, unknown>, close = false) => {
    setBusy(true)
    setError('')
    try {
      const result = await run({ operation, input })
      if (!mounted.current) return result
      if (close) {
        onSelected?.()
        onClose()
      } else if (['mcpAuth', 'providerConnect'].includes(operation))
        setAuth({
          ...(result as object),
          kind: operation === 'mcpAuth' ? 'mcp' : 'provider',
          id: input?.id,
          name: input?.name,
          methodIndex: input?.method,
        })
      else if (!NATIVE_MUTATIONS.has(operation)) setData(result)
      else {
        if (['providerCallback', 'mcpCallback', 'mcpAuthenticate'].includes(operation)) setAuth(null)
        await refresh()
      }
      return result
    } catch (e) {
      if (mounted.current) setError(errorText(e))
      return null
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  const list = Array.isArray(data) ? data : []
  const filtered = (items: any[]) =>
    items.filter((x) =>
      [x.name, x.id, x.title, x.path, x.description, x.info?.role, ...(x.parts ?? []).map((p: any) => p.text ?? '')]
        .join(' ')
        .toLowerCase()
        .includes(query.toLowerCase()),
    )
  return (
    <div
      className="native-panel-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <section
        ref={dialog}
        className="native-panel"
        role="dialog"
        aria-modal="true"
        aria-label={view.title}
        onKeyDown={(e) => {
          if ((e.target as HTMLElement).closest('.native-terminal')) return
          if (e.key === 'Escape' && !(e.target as HTMLElement).closest('.native-terminal')) {
            e.preventDefault()
            e.stopPropagation()
            onClose()
          }
          if (e.key === 'Tab') {
            const controls = [
              ...e.currentTarget.querySelectorAll<HTMLElement>(
                'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],summary',
              ),
            ].filter((el) => el.getClientRects().length)
            const first = controls[0],
              last = controls.at(-1)
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault()
              last?.focus()
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault()
              first?.focus()
            }
          }
        }}
      >
        <header>
          <strong>{view.title}</strong>
          <span />
          <button className="ghost" onClick={() => void refresh()} disabled={busy}>
            Refresh
          </button>
          <button className="ghost" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {busy && (
          <p role="status" className="muted">
            Working…
          </p>
        )}
        {view.preview && (
          <div className="native-share">
            <p>
              This will publish the native conversation, including its tool results and file references. Review the
              complete history below.
            </p>
            <button
              className="primary"
              disabled={busy || data === null || Boolean(sharedUrl)}
              onClick={() => {
                void (async () => {
                  const bytes = new TextEncoder().encode(JSON.stringify(data))
                  const digest = await crypto.subtle.digest('SHA-256', bytes)
                  const previewHash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join(
                    '',
                  )
                  const result = await action('share', { previewHash })
                  if (result) setSharedUrl((result as any).share?.url ?? (result as any).url ?? '')
                })().catch((e) => setError(errorText(e)))
              }}
            >
              Create public link
            </button>
            {sharedUrl && (
              <a
                href={sharedUrl}
                onClick={(e) => {
                  e.preventDefault()
                  window.open(sharedUrl, '_blank', 'noopener')
                }}
              >
                {sharedUrl}
              </a>
            )}
          </div>
        )}
        {['agents', 'models', 'skills', 'commands', 'sessions', 'history', 'files', 'providers'].includes(
          view.operation,
        ) && (
          <input
            className="native-search"
            placeholder="Search…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search native records"
          />
        )}
        <div className="native-panel-body">
          {view.action && (
            <form
              onSubmit={(e) => {
                e.preventDefault()
                void action(view.action!, view.action === 'rename' ? { title: form } : { command: form }, true)
              }}
            >
              <textarea
                rows={view.action === 'shell' ? 4 : 1}
                autoFocus
                value={form}
                onChange={(e) => setForm(e.target.value)}
                placeholder={view.action === 'rename' ? data?.title : 'Enter a command to run in this project'}
              />
              <button className="primary" disabled={busy || !form.trim()}>
                Run
              </button>
            </form>
          )}
          {view.operation === 'agents' ? (
            filtered(list.filter((a: any) => !a.hidden && a.mode !== 'subagent')).map((agent: any) => (
              <article key={agent.name}>
                <button disabled={busy} onClick={() => void action('select', { agent: agent.name }, true)}>
                  {agent.name}
                </button>
                <p className="muted">{agent.description}</p>
                <NativeValue value={agent} />
              </article>
            ))
          ) : view.operation === 'models' ? (
            (data?.all ?? [])
              .filter((p: any) => data?.connected?.includes(p.id))
              .map((p: any) => (
                <details key={p.id}>
                  <summary>{p.name ?? p.id}</summary>
                  {filtered(Object.values(p.models ?? {})).map((model: any) => (
                    <article key={model.id}>
                      <button
                        disabled={busy}
                        onClick={() =>
                          void action('select', { model: { providerID: p.id, modelID: model.id }, variant: '' }, true)
                        }
                      >
                        {model.name ?? model.id}
                      </button>
                      {Object.keys(model.variants ?? {}).map((variant) => (
                        <button
                          key={variant}
                          disabled={busy}
                          onClick={() =>
                            void action('select', { model: { providerID: p.id, modelID: model.id }, variant }, true)
                          }
                        >
                          {variant}
                        </button>
                      ))}
                      <NativeValue value={model} />
                    </article>
                  ))}
                </details>
              ))
          ) : view.operation === 'commands' || view.operation === 'skills' ? (
            filtered(list).map((item: any) => (
              <article key={item.name}>
                <button
                  disabled={busy}
                  onClick={() => void action('command', { command: item.name, arguments: '' }, true)}
                >
                  /{item.name}
                </button>
                <p className="muted">{item.description}</p>
                <NativeValue value={item} />
              </article>
            ))
          ) : view.operation === 'sessions' ? (
            filtered(list).map((item: any) => (
              <article key={item.id}>
                <button onClick={() => void action('open', { id: item.id }, true)}>{item.title || item.id}</button>
                {item.time?.archived > 0 && <span className="muted"> Archived</span>}
                <NativeValue value={item} />
              </article>
            ))
          ) : view.operation === 'history' ? (
            filtered(list).map((item: any) => (
              <article key={item.info?.id}>
                <details>
                  <summary>
                    {item.info?.role} · {new Date(item.info?.time?.created ?? 0).toLocaleString()}
                  </summary>
                  {(item.parts ?? []).map((part: any, index: number) => (
                    <div key={index}>
                      {part.type === 'text' ? (
                        <Markdown text={part.text ?? ''} />
                      ) : (
                        <NativeValue value={part} label={part.type} />
                      )}
                    </div>
                  ))}
                </details>
                {item.info?.role === 'user' && (
                  <>
                    <button disabled={busy} onClick={() => void action('fork', { messageID: item.info.id }, true)}>
                      Branch here
                    </button>
                    <button disabled={busy} onClick={() => void action('undo', { messageID: item.info.id }, true)}>
                      Undo from here
                    </button>
                  </>
                )}
              </article>
            ))
          ) : view.operation === 'config' ? (
            <>
              <NativeValue value={data} />
              <p className="muted">Enter only the settings to change. Credentials are hidden from the preview.</p>
              <textarea
                rows={10}
                placeholder="Partial JSON settings patch"
                value={form}
                onChange={(e) => setForm(e.target.value)}
              />
              <button
                disabled={busy || !form}
                onClick={() => {
                  try {
                    void action('configUpdate', JSON.parse(form))
                    setForm('')
                  } catch (e) {
                    setError(errorText(e))
                  }
                }}
              >
                Apply settings
              </button>
            </>
          ) : view.operation === 'permissionSaved' ? (
            <>
              {list.map((permission: any) => (
                <article key={permission.id}>
                  <NativeValue value={permission} />
                  <button disabled={busy} onClick={() => void action('permissionRemove', { id: permission.id })}>
                    Forget permission
                  </button>
                </article>
              ))}
            </>
          ) : view.operation === 'children' ? (
            <>
              {list.map((child: any) => (
                <article key={child.id}>
                  <button onClick={() => void action('open', { id: child.id }, true)}>{child.title ?? child.id}</button>
                  <NativeValue value={child} />
                </article>
              ))}
            </>
          ) : view.operation === 'mcp' ? (
            <>
              <McpList data={data} busy={busy} action={action} />
              <details>
                <summary>Add a tool server</summary>
                <input placeholder="Server name" value={provider} onChange={(e) => setProvider(e.target.value)} />
                <textarea
                  rows={6}
                  placeholder={'{"type":"remote","url":"https://…"}'}
                  value={form}
                  onChange={(e) => setForm(e.target.value)}
                />
                <button
                  disabled={busy || !provider || !form}
                  onClick={() => {
                    try {
                      void action('mcpAdd', { name: provider, config: JSON.parse(form) })
                    } catch (e) {
                      setError(errorText(e))
                    }
                  }}
                >
                  Add MCP server
                </button>
              </details>
            </>
          ) : view.operation === 'providers' ? (
            <>
              <ProviderList
                data={data}
                query={query}
                busy={busy}
                onChoose={async (id) => {
                  const epoch = ++requestEpoch.current
                  setBusy(true)
                  setProvider(id)
                  setAuth(null)
                  setSecret('')
                  try {
                    const result = await run({ operation: 'providerAuth' })
                    if (mounted.current && epoch === requestEpoch.current) setAuth(result)
                  } catch (e) {
                    if (mounted.current && epoch === requestEpoch.current) setError(errorText(e))
                  } finally {
                    if (mounted.current && epoch === requestEpoch.current) setBusy(false)
                  }
                }}
              />
              {provider && (
                <article>
                  <strong>{provider}</strong>
                  <label>
                    API key
                    <input
                      type="password"
                      autoComplete="off"
                      value={secret}
                      onChange={(e) => setSecret(e.target.value)}
                    />
                  </label>
                  <button
                    disabled={busy || !secret}
                    onClick={() => {
                      void action('providerKey', { id: provider, key: secret })
                      setSecret('')
                    }}
                  >
                    Connect with key
                  </button>
                  <button disabled={busy} onClick={() => void action('providerRemove', { id: provider })}>
                    Disconnect
                  </button>
                  {Array.isArray(auth?.[provider]) &&
                    auth[provider].map((method: any, index: number) =>
                      method.type === 'oauth' ? (
                        <ProviderMethod
                          key={provider + ':' + index}
                          method={method}
                          busy={busy}
                          onConnect={(inputs) =>
                            void action('providerConnect', { id: provider, method: index, inputs })
                          }
                        />
                      ) : null,
                    )}
                </article>
              )}
            </>
          ) : view.operation === 'terminals' ? (
            <>
              <button
                disabled={busy}
                onClick={() =>
                  void action('terminalCreate').then((p: any) => {
                    if (p?.id) setTerminal(p.id)
                  })
                }
              >
                New terminal
              </button>
              {list.map((p: any) => (
                <article key={p.id}>
                  <button onClick={() => setTerminal(p.id)}>
                    {p.title ?? p.id} · {p.status}
                  </button>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void action('terminalRemove', { id: p.id }).then(() => {
                        if (terminal === p.id) setTerminal('')
                      })
                    }
                  >
                    Close terminal
                  </button>
                </article>
              ))}
              {terminal && (
                <Suspense fallback={<p>Opening terminal…</p>}>
                  <NativeTerminal id={terminal} run={run} />
                </Suspense>
              )}
            </>
          ) : view.operation === 'files' ? (
            Array.isArray(data) ? (
              filtered(list).map((item: any) => (
                <article key={item.path}>
                  <button
                    onClick={() => {
                      setBusy(true)
                      void run({ operation: item.type === 'directory' ? 'files' : 'file', input: { path: item.path } })
                        .then(setData)
                        .catch((e) => setError(errorText(e)))
                        .finally(() => setBusy(false))
                    }}
                  >
                    {item.name ?? item.path}
                  </button>
                  <NativeValue value={item} />
                </article>
              ))
            ) : (
              <NativeValue value={data} />
            )
          ) : view.operation === 'find' || view.operation === 'symbols' ? (
            <>
              <input
                placeholder="Search query"
                value={form}
                onChange={(e) => setForm(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter')
                    void run({ operation: view.operation, input: { pattern: form, query: form } })
                      .then(setData)
                      .catch((e) => setError(errorText(e)))
                }}
              />
              <button
                disabled={busy}
                onClick={() =>
                  void run({ operation: view.operation, input: { pattern: form, query: form } })
                    .then(setData)
                    .catch((e) => setError(errorText(e)))
                }
              >
                Search
              </button>
              <NativeValue value={data} />
            </>
          ) : view.operation === 'organizations' ? (
            <>
              {(data?.orgs ?? []).map((org: any) => (
                <article key={org.accountID + ':' + org.orgID}>
                  <strong>{org.orgName}</strong>
                  <p className="muted">{org.accountEmail}</p>
                  <button
                    disabled={busy || org.active}
                    onClick={() => void action('organizationSwitch', { accountID: org.accountID, orgID: org.orgID })}
                  >
                    {org.active ? 'Current' : 'Switch'}
                  </button>
                </article>
              ))}
              <NativeValue value={data} />
            </>
          ) : view.operation === 'gitStatus' ? (
            <>
              <NativeValue value={data} />
              <button disabled={busy} onClick={() => void action('gitDiff', { mode: 'git' })}>
                Review file changes
              </button>
              <button disabled={busy} onClick={() => void action('gitDiff', { mode: 'branch' })}>
                Compare with default branch
              </button>
              <details>
                <summary>Apply a patch</summary>
                <textarea
                  rows={8}
                  value={form}
                  onChange={(e) => setForm(e.target.value)}
                  placeholder="Paste the complete patch to apply"
                />
                <button disabled={busy || !form.trim()} onClick={() => void action('gitApply', { patch: form })}>
                  Apply patch
                </button>
              </details>
            </>
          ) : view.operation === 'worktrees' || view.operation === 'workspaces' ? (
            <>
              <NativeValue value={data} />
              <details>
                <summary>Create / manage</summary>
                <textarea
                  rows={5}
                  value={form}
                  onChange={(e) => setForm(e.target.value)}
                  placeholder="Native configuration JSON"
                />
                <button
                  disabled={busy}
                  onClick={() => {
                    try {
                      void action(
                        view.operation === 'worktrees' ? 'worktreeCreate' : 'workspaceCreate',
                        form ? JSON.parse(form) : {},
                      )
                    } catch (e) {
                      setError(errorText(e))
                    }
                  }}
                >
                  Create
                </button>
                <button
                  disabled={busy || !form}
                  onClick={() => {
                    try {
                      void action(
                        view.operation === 'worktrees' ? 'worktreeRemove' : 'workspaceRemove',
                        JSON.parse(form),
                      )
                    } catch (e) {
                      setError(errorText(e))
                    }
                  }}
                >
                  Remove
                </button>
                {view.operation === 'workspaces' && (
                  <>
                    <button
                      disabled={busy}
                      onClick={() => {
                        try {
                          void action('workspaceSync', form ? JSON.parse(form) : {})
                        } catch (e) {
                          setError(errorText(e))
                        }
                      }}
                    >
                      Synchronize
                    </button>
                    <button disabled={busy} onClick={() => void action('workspaceStatus')}>
                      Status
                    </button>
                    <button disabled={busy} onClick={() => void action('workspaceAdapters')}>
                      Adapters
                    </button>
                  </>
                )}
                {view.operation === 'worktrees' && (
                  <button
                    disabled={busy || !form}
                    onClick={() => {
                      try {
                        void action('worktreeReset', JSON.parse(form))
                      } catch (e) {
                        setError(errorText(e))
                      }
                    }}
                  >
                    Reset
                  </button>
                )}
              </details>
            </>
          ) : (
            <NativeValue value={data} />
          )}
          {(auth?.url || auth?.authorizationUrl) && (
            <article>
              <a
                href={auth.url ?? auth.authorizationUrl}
                onClick={(e) => {
                  e.preventDefault()
                  if (/^https?:\/\//.test(auth.url ?? auth.authorizationUrl))
                    window.open(auth.url ?? auth.authorizationUrl, '_blank', 'noopener')
                }}
              >
                Open authentication page
              </a>
              <p>{auth.instructions}</p>
              <>
                <input
                  placeholder="Authorization code, if requested"
                  autoComplete="off"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                />
                <button
                  disabled={busy}
                  onClick={() => {
                    void action(
                      auth.kind === 'mcp' ? 'mcpCallback' : 'providerCallback',
                      auth.kind === 'mcp'
                        ? { name: auth.name, code: secret }
                        : { id: auth.id, method: auth.methodIndex ?? 0, ...(secret ? { code: secret } : {}) },
                    )
                    setSecret('')
                  }}
                >
                  Finish sign-in
                </button>
              </>
            </article>
          )}
        </div>
      </section>
    </div>
  )
}
function McpList({
  data,
  busy,
  action,
}: {
  data: any
  busy: boolean
  action: (op: NativeOperation, input?: Record<string, unknown>) => Promise<unknown>
}) {
  return (
    <>
      {Object.entries(data ?? {}).map(([name, status]: [string, any]) => (
        <article key={name}>
          <strong>{name}</strong>
          <span> · {status.status}</span>
          <button
            disabled={busy}
            onClick={() => void action(status.status === 'connected' ? 'mcpDisconnect' : 'mcpConnect', { name })}
          >
            {status.status === 'connected' ? 'Disconnect' : 'Connect'}
          </button>
          <button disabled={busy} onClick={() => void action('mcpAuth', { name })}>
            Get sign-in link
          </button>
          <button disabled={busy} onClick={() => void action('mcpAuthenticate', { name })}>
            Sign in with browser
          </button>
          <button disabled={busy} onClick={() => void action('mcpAuthRemove', { name })}>
            Remove sign-in
          </button>
          <NativeValue value={status} />
        </article>
      ))}
    </>
  )
}
function ProviderList({
  data,
  query,
  busy,
  onChoose,
}: {
  data: any
  query: string
  busy: boolean
  onChoose(id: string): void
}) {
  return (
    <>
      {(data?.all ?? [])
        .filter((p: any) => (p.name + ' ' + p.id).toLowerCase().includes(query.toLowerCase()))
        .map((p: any) => (
          <article key={p.id}>
            <button disabled={busy} onClick={() => onChoose(p.id)}>
              {p.name ?? p.id}
            </button>
            <span className="muted">{data.connected?.includes(p.id) ? ' Connected' : ''}</span>
          </article>
        ))}
    </>
  )
}

function ProviderMethod({
  method,
  busy,
  onConnect,
}: {
  method: any
  busy: boolean
  onConnect(inputs: Record<string, string>): void
}) {
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const visible = (method.prompts ?? []).filter(
    (p: any) =>
      !p.when || (p.when.op === 'eq' ? inputs[p.when.key] === p.when.value : inputs[p.when.key] !== p.when.value),
  )
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        onConnect(Object.fromEntries(visible.map((p: any) => [p.key, inputs[p.key] ?? ''])))
      }}
    >
      {visible.map((p: any) => (
        <label key={p.key}>
          {p.message}
          {p.type === 'select' ? (
            <select
              value={inputs[p.key] ?? ''}
              required
              onChange={(e) => setInputs((v) => ({ ...v, [p.key]: e.target.value }))}
            >
              <option value="" disabled>
                Choose…
              </option>
              {p.options.map((o: any) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                  {o.hint ? ' · ' + o.hint : ''}
                </option>
              ))}
            </select>
          ) : (
            <input
              autoComplete="off"
              placeholder={p.placeholder}
              value={inputs[p.key] ?? ''}
              onChange={(e) => setInputs((v) => ({ ...v, [p.key]: e.target.value }))}
            />
          )}
        </label>
      ))}
      <button disabled={busy}>{method.label}</button>
    </form>
  )
}
