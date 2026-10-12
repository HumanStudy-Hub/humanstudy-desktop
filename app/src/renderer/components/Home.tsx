import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react'
import type { AccountStatus, ProjectSummary } from '../../preload/types'
import { Studies, type StudiesHandle } from './Studies'
import { track } from '../telemetry'
import { VersionFooter } from './Updates'
import { KernelBar } from './KernelBar'
import type { KernelInstallStatus } from '../../preload/types'
import { errorText } from './SettingsDialog'
import { relativeTime } from '../format'
import { t } from '../i18n'

type Section = 'projects' | 'studies'
const SECTION_KEY = 'hs.homeSection'

interface Props {
  onOpen(dir: string): void
  onSettings(): void
  account: AccountStatus | null
  /** Opens Settings → Account. */
  onAccount(): void
  kernel: { status: KernelInstallStatus | null; retry(): void }
}

export { relativeTime }

const baseName = (path: string) => (path.split(/[\\/]/).pop() ?? '').replace(/\.pdf$/i, '').trim() || t('home.untitled')

export interface HomeHandle {
  /** Same as the "From a paper" card: pick a PDF and start a project. */
  fromPaper(): void
}

export function Home({ ref, onOpen, onSettings, account, onAccount, kernel }: Props & { ref?: Ref<HomeHandle> }) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null)
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const [folderProblem, setFolderProblem] = useState(false)
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
    if (next !== section) track('home.section', { target: next })
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
      setFolderProblem(false)
    } catch (e) {
      setProjects([])
      setFolderProblem(true)
      setError(errorText(e, t('home.err_list')))
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
      setError(e instanceof Error ? e.message : t('home.err_generic'))
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
  useImperativeHandle(ref, () => ({ fromPaper: () => void fromPaper() }))
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
          HumanStudy Hub
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
            placeholder={t(section === 'studies' ? 'home.search_studies' : 'home.search_projects')}
            aria-label={t(section === 'studies' ? 'home.search_studies' : 'home.search_projects')}
          />
          <kbd>⌘K</kbd>
        </label>
        <div className="titlebar-actions">
          <button className="ghost" onClick={openFolder} disabled={busy}>
            {t('home.open_folder')}
          </button>
          <button className="ghost" onClick={onSettings}>
            {t('home.settings')}
          </button>
          {account && !account.signedIn && (
            <button className="primary signin-btn" onClick={onAccount}>
              {t('home.signin')}
            </button>
          )}
          {account?.signedIn && (
            <button className="ghost account-chip" onClick={onAccount} title={t('home.account')}>
              <span className="avatar" style={{ width: 22, height: 22, fontSize: 11 }} aria-hidden>
                {(account.email ?? '?').slice(0, 1).toUpperCase()}
              </span>
              <span className="account-email">{account.email}</span>
            </button>
          )}
        </div>
      </header>

      <div className="home-body">
        <nav className="home-side" aria-label={t('home.sections')}>
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
            {t('home.projects')}
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
            {t('home.studies')}
          </button>
          <VersionFooter />
        </nav>
        <main className="home-main">
          {section === 'studies' ? (
            <Studies ref={studies} query={query} onOpenProject={onOpen} />
          ) : (
            <div className="home-inner">
              <KernelBar kernel={kernel} />
              {!query && account?.modelAccess === 'none' && (
                <button className="access-banner" onClick={onAccount}>
                  <span>{t('home.need_access')}</span>
                  <span className="access-banner-go" aria-hidden>
                    →
                  </span>
                </button>
              )}
              {!query && (
                <section className="home-section">
                  <h2 className="home-label">{t('home.start_new')}</h2>
                  <div className="tiles">
                    <button className="tile" onClick={fromPaper} disabled={busy}>
                      <span className="tile-art paper" aria-hidden>
                        <i />
                        <i />
                        <i />
                      </span>
                      <strong>{t('home.from_paper')}</strong>
                      <span className="muted small">{t('home.from_paper_hint')}</span>
                    </button>
                    {blank === null ? (
                      <button className="tile" onClick={() => setBlank('')} disabled={busy}>
                        <span className="tile-art blank" aria-hidden>
                          +
                        </span>
                        <strong>{t('home.blank')}</strong>
                        <span className="muted small">{t('home.blank_hint')}</span>
                      </button>
                    ) : (
                      <form
                        className="tile tile-form"
                        onSubmit={(e) => {
                          e.preventDefault()
                          createBlank()
                        }}
                      >
                        <strong>{t('home.blank')}</strong>
                        <input
                          autoFocus
                          className="field"
                          value={blank}
                          placeholder={t('home.project_name')}
                          onChange={(e) => setBlank(e.target.value)}
                          onKeyDown={(e) => e.key === 'Escape' && setBlank(null)}
                        />
                        <div className="row-end">
                          <button type="button" className="ghost" onClick={() => setBlank(null)}>
                            {t('home.cancel')}
                          </button>
                          <button type="submit" className="primary" disabled={busy || !blank.trim()}>
                            {t('home.create')}
                          </button>
                        </div>
                      </form>
                    )}
                    <button className="tile" onClick={sample} disabled={busy}>
                      <span className="tile-art sample" aria-hidden>
                        <i />
                        <i />
                      </span>
                      <strong>{t('home.sample')}</strong>
                      <span className="muted small">{t('home.sample_hint')}</span>
                    </button>
                  </div>
                </section>
              )}

              {error && (
                <p className="home-error">
                  {error}
                  {folderProblem && (
                    <>
                      {' '}
                      <button
                        className="ghost"
                        onClick={() =>
                          void window.humanstudy.settings.pickProjectsRoot().then((next) => {
                            if (next) {
                              setError('')
                              void refresh()
                            }
                          })
                        }
                      >
                        {t('home.choose_folder')}
                      </button>
                    </>
                  )}
                </p>
              )}

              <section className="home-section">
                <h2 className="home-label">{query ? t('home.results_for', { q: query }) : t('home.recent')}</h2>
                {projects === null ? (
                  <p className="muted small">{t('common.loading')}</p>
                ) : shown.length === 0 ? (
                  <div className="home-empty">
                    {query ? (
                      <p className="muted">{t('home.no_match')}</p>
                    ) : (
                      <>
                        <p>{t('home.no_projects')}</p>
                        <p className="muted small">{t('home.no_projects_hint')}</p>
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
                              aria-label={t('home.project_name')}
                            />
                          </form>
                        ) : (
                          <button className="project-row" onClick={() => onOpen(p.dir)} title={p.dir}>
                            <span className="doc-icon" aria-hidden />
                            <span className="project-name">
                              {p.name}
                              {p.title && <span className="muted small project-title"> · {p.title}</span>}
                            </span>
                            <span className="badges">
                              {p.hasPaper && <span className="badge">{t('home.badge_paper')}</span>}
                              {p.hasProgram && <span className="badge">{t('home.badge_study')}</span>}
                              {p.artifactCount > 0 && (
                                <span className="badge">
                                  {t(p.artifactCount === 1 ? 'home.badge_results_one' : 'home.badge_results_other', { n: p.artifactCount })}
                                </span>
                              )}
                            </span>
                            <span className="project-time muted small">{relativeTime(p.updatedAt)}</span>
                          </button>
                        )}
                        {confirmTrash === p.dir ? (
                          <span className="confirm">
                            <span className="small muted">{t('home.trash_q')}</span>
                            <button className="ghost danger" onClick={() => void trash(p.dir)} disabled={busy}>
                              {t('home.trash_move')}
                            </button>
                            <button className="ghost" onClick={() => setConfirmTrash(null)}>
                              {t('home.cancel')}
                            </button>
                          </span>
                        ) : (
                          <span className="menu row-menu">
                            <button
                              className="ghost more"
                              aria-label={t('home.more', { name: p.name })}
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
                                  {t('home.rename')}
                                </button>
                                <button
                                  className="menu-item row"
                                  role="menuitem"
                                  onClick={() => {
                                    setMenu(null)
                                    void window.humanstudy.project.reveal(p.dir)
                                  }}
                                >
                                  {t('home.reveal')}
                                </button>
                                <button
                                  className="menu-item row danger"
                                  role="menuitem"
                                  onClick={() => {
                                    setMenu(null)
                                    setConfirmTrash(p.dir)
                                  }}
                                >
                                  {t('home.trash')}
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
