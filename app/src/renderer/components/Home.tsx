import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ProjectSummary } from '../../preload/types'
import { Studies, type StudiesHandle } from './Studies'

type Section = 'projects' | 'studies'
const SECTION_KEY = 'hs.homeSection'

interface Props {
  onOpen(dir: string): void
  onSettings(): void
}

export function relativeTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  if (d === 1) return 'yesterday'
  if (d < 7) return `${d} days ago`
  return new Date(t).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: d > 300 ? 'numeric' : undefined,
  })
}

const baseName = (path: string) => (path.split(/[\\/]/).pop() ?? '').replace(/\.pdf$/i, '').trim() || 'Untitled project'

export function Home({ onOpen, onSettings }: Props) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null)
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [blank, setBlank] = useState<string | null>(null)
  const [menu, setMenu] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ dir: string; name: string } | null>(null)
  const [confirmTrash, setConfirmTrash] = useState<string | null>(null)
  const search = useRef<HTMLInputElement>(null)
  const studies = useRef<StudiesHandle>(null)
  const [section, setSectionState] = useState<Section>(() => {
    try {
      return localStorage.getItem(SECTION_KEY) === 'studies' ? 'studies' : 'projects'
    } catch {
      return 'projects'
    }
  })
  const setSection = (next: Section) => {
    setSectionState(next)
    setQuery('')
    try {
      localStorage.setItem(SECTION_KEY, next)
    } catch {
      /* ignore */
    }
  }

  const refresh = useCallback(async () => {
    try {
      setProjects(await window.humanstudy.projects.list())
    } catch (e) {
      setProjects([])
      setError(e instanceof Error ? e.message : 'Could not list projects.')
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    const keys = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        search.current?.focus()
        search.current?.select()
      }
    }
    window.addEventListener('keydown', keys)
    return () => window.removeEventListener('keydown', keys)
  }, [])

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [menu])

  const run = async (task: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await task()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.')
    } finally {
      setBusy(false)
    }
  }

  const fromPaper = () =>
    run(async () => {
      const pdfPath = await window.humanstudy.projects.pickPdf()
      if (!pdfPath) return
      onOpen(await window.humanstudy.projects.create({ name: baseName(pdfPath), pdfPath }))
    })
  const createBlank = () => {
    const name = blank?.trim()
    if (!name) return
    void run(async () => onOpen(await window.humanstudy.projects.create({ name })))
  }
  const sample = () => run(async () => onOpen(await window.humanstudy.projects.create({ name: '', sample: true })))
  const openFolder = () =>
    run(async () => {
      const dir = await window.humanstudy.project.open()
      if (dir) onOpen(dir)
    })
  const saveRename = () => {
    if (!renaming) return
    const { dir, name } = renaming
    const original = projects?.find((p) => p.dir === dir)?.name
    setRenaming(null)
    if (!name.trim() || name.trim() === original) return
    void run(async () => {
      await window.humanstudy.projects.rename(dir, name.trim())
      await refresh()
    })
  }
  const trash = (dir: string) =>
    run(async () => {
      setConfirmTrash(null)
      await window.humanstudy.projects.trash(dir)
      await refresh()
    })

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = [...(projects ?? [])].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    return q ? list.filter((p) => p.name.toLowerCase().includes(q)) : list
  }, [projects, query])

  return (
    <div className="home">
      <header className="titlebar home-bar">
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          HumanStudy
        </div>
        <label className="home-search">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
            <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            ref={search}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setQuery('')
                e.currentTarget.blur()
              }
              if (e.key === 'Enter') {
                if (section === 'studies') studies.current?.openFirst()
                else if (shown[0]) onOpen(shown[0].dir)
              }
            }}
            placeholder={section === 'studies' ? 'Search studies' : 'Search projects'}
            aria-label={section === 'studies' ? 'Search studies' : 'Search projects'}
          />
          <kbd>⌘K</kbd>
        </label>
        <div className="titlebar-actions">
          <button className="ghost" onClick={openFolder} disabled={busy}>
            Open folder
          </button>
          <button className="ghost" onClick={onSettings}>
            Settings
          </button>
        </div>
      </header>

      <div className="home-body">
        <nav className="home-side" aria-label="Sections">
          <button aria-current={section === 'projects' ? 'page' : undefined} onClick={() => setSection('projects')}>
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden>
              <path
                d="M2 4.5c0-.8.7-1.5 1.5-1.5h3l1.5 1.5h4.5c.8 0 1.5.7 1.5 1.5v5.5c0 .8-.7 1.5-1.5 1.5h-9c-.8 0-1.5-.7-1.5-1.5z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinejoin="round"
              />
            </svg>
            Projects
          </button>
          <button aria-current={section === 'studies' ? 'page' : undefined} onClick={() => setSection('studies')}>
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden>
              <path
                d="M2.5 3.5h4c.8 0 1.5.7 1.5 1.5v8c0-.6-.5-1-1-1h-4.5zM13.5 3.5h-4c-.8 0-1.5.7-1.5 1.5v8c0-.6.5-1 1-1h4.5z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinejoin="round"
              />
            </svg>
            Studies
          </button>
        </nav>
        <main className="home-main">
          {section === 'studies' ? (
            <Studies ref={studies} query={query} onOpenProject={onOpen} />
          ) : (
            <div className="home-inner">
              {!query && (
                <section className="home-section">
                  <h2 className="home-label">Start a new project</h2>
                  <div className="tiles">
                    <button className="tile" onClick={fromPaper} disabled={busy}>
                      <span className="tile-art paper" aria-hidden>
                        <i />
                        <i />
                        <i />
                      </span>
                      <strong>From a paper</strong>
                      <span className="muted small">Pick a PDF; the agent builds its Human Program.</span>
                    </button>
                    {blank === null ? (
                      <button className="tile" onClick={() => setBlank('')} disabled={busy}>
                        <span className="tile-art blank" aria-hidden>
                          +
                        </span>
                        <strong>Blank project</strong>
                        <span className="muted small">An empty folder to fill with sources later.</span>
                      </button>
                    ) : (
                      <form
                        className="tile tile-form"
                        onSubmit={(e) => {
                          e.preventDefault()
                          createBlank()
                        }}
                      >
                        <strong>Blank project</strong>
                        <input
                          autoFocus
                          className="field"
                          value={blank}
                          placeholder="Project name"
                          onChange={(e) => setBlank(e.target.value)}
                          onKeyDown={(e) => e.key === 'Escape' && setBlank(null)}
                        />
                        <div className="row-end">
                          <button type="button" className="ghost" onClick={() => setBlank(null)}>
                            Cancel
                          </button>
                          <button type="submit" className="primary" disabled={busy || !blank.trim()}>
                            Create
                          </button>
                        </div>
                      </form>
                    )}
                    <button className="tile" onClick={sample} disabled={busy}>
                      <span className="tile-art sample" aria-hidden>
                        <i />
                        <i />
                      </span>
                      <strong>Sample · Knobe 2003</strong>
                      <span className="muted small">The side-effect effect, ready to explore.</span>
                    </button>
                  </div>
                </section>
              )}

              {error && <p className="home-error">{error}</p>}

              <section className="home-section">
                <h2 className="home-label">{query ? `Results for “${query}”` : 'Recent projects'}</h2>
                {projects === null ? (
                  <p className="muted small">Loading…</p>
                ) : shown.length === 0 ? (
                  <div className="home-empty">
                    {query ? (
                      <p className="muted">No project matches that name.</p>
                    ) : (
                      <>
                        <p>No projects yet.</p>
                        <p className="muted small">Start from a paper, or open the Knobe 2003 sample to look around.</p>
                      </>
                    )}
                  </div>
                ) : (
                  <ul className="project-list">
                    {shown.map((p) => (
                      <li key={p.dir} className={menu === p.dir ? 'menu-open' : ''}>
                        {renaming?.dir === p.dir ? (
                          <form
                            className="project-row editing"
                            onSubmit={(e) => {
                              e.preventDefault()
                              saveRename()
                            }}
                          >
                            <span className="doc-icon" aria-hidden />
                            <input
                              autoFocus
                              className="field"
                              value={renaming.name}
                              onChange={(e) => setRenaming({ dir: p.dir, name: e.target.value })}
                              onBlur={saveRename}
                              onKeyDown={(e) => e.key === 'Escape' && setRenaming(null)}
                              aria-label="Project name"
                            />
                          </form>
                        ) : (
                          <button className="project-row" onClick={() => onOpen(p.dir)} title={p.dir}>
                            <span className="doc-icon" aria-hidden />
                            <span className="project-name">{p.name}</span>
                            <span className="badges">
                              {p.hasPaper && <span className="badge">Paper</span>}
                              {p.hasProgram && <span className="badge">Program</span>}
                              {p.artifactCount > 0 && (
                                <span className="badge">
                                  {p.artifactCount} artifact{p.artifactCount === 1 ? '' : 's'}
                                </span>
                              )}
                            </span>
                            <span className="project-time muted small">{relativeTime(p.updatedAt)}</span>
                          </button>
                        )}
                        {confirmTrash === p.dir ? (
                          <span className="confirm">
                            <span className="small muted">Move to Trash?</span>
                            <button className="ghost danger" onClick={() => void trash(p.dir)} disabled={busy}>
                              Move
                            </button>
                            <button className="ghost" onClick={() => setConfirmTrash(null)}>
                              Cancel
                            </button>
                          </span>
                        ) : (
                          <span className="menu row-menu">
                            <button
                              className="ghost more"
                              aria-label={`More actions for ${p.name}`}
                              aria-expanded={menu === p.dir}
                              onClick={(e) => {
                                e.stopPropagation()
                                setMenu(menu === p.dir ? null : p.dir)
                              }}
                            >
                              ⋯
                            </button>
                            {menu === p.dir && (
                              <div className="menu-pop narrow" role="menu" onClick={(e) => e.stopPropagation()}>
                                <button
                                  className="menu-item row"
                                  role="menuitem"
                                  onClick={() => {
                                    setMenu(null)
                                    setRenaming({ dir: p.dir, name: p.name })
                                  }}
                                >
                                  Rename
                                </button>
                                <button
                                  className="menu-item row"
                                  role="menuitem"
                                  onClick={() => {
                                    setMenu(null)
                                    void window.humanstudy.project.reveal(p.dir)
                                  }}
                                >
                                  Show in Finder
                                </button>
                                <button
                                  className="menu-item row danger"
                                  role="menuitem"
                                  onClick={() => {
                                    setMenu(null)
                                    setConfirmTrash(p.dir)
                                  }}
                                >
                                  Move to Trash
                                </button>
                              </div>
                            )}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
