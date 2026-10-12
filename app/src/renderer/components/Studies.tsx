import { useCallback, useEffect, useImperativeHandle, useMemo, useState, type Ref } from 'react'
import type { CommunityStudy, CommunityStudyDetail } from '../../preload/types'
import { relativeTime } from './Home'
import { track } from '../telemetry'

const REPO_URL = 'https://github.com/HumanStudy-Hub/HumanStudy-Bench'

export interface StudiesHandle {
  /** Opens the first study that matches the current search (Enter in the search box). */
  openFirst(): void
}

interface Props {
  query: string
  onOpenProject(dir: string): void
  ref?: Ref<StudiesHandle>
}

// Kept across section switches so returning to Studies doesn't flash a loading state.
let cachedList: CommunityStudy[] | null = null

const errorText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback)
const open = (url: string) => void window.humanstudy.community.openExternal(url)

export function byline(s: Pick<CommunityStudy, 'authors' | 'year'>, max = Infinity): string {
  const names = s.authors.length > max ? `${s.authors.slice(0, max).join(', ')} et al.` : s.authors.join(', ')
  return [names, s.year ?? ''].filter(Boolean).join(' · ')
}

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

const initials = (name: string) =>
  name
    .replace(/^@/, '')
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '?'

function Avatar({ name, src, size = 22 }: { name: string; src?: string; size?: number }) {
  const [failed, setFailed] = useState(false)
  return (
    <span
      className="avatar"
      style={{ width: size, height: size, fontSize: size * 0.42 }}
      title={name}
      aria-label={name}
    >
      {src && !failed ? <img src={src} alt="" onError={() => setFailed(true)} /> : initials(name)}
    </span>
  )
}

const contributorAvatar = (c: CommunityStudy['contributors'][number]) =>
  c.github ? `https://github.com/${encodeURIComponent(c.github)}.png?size=64` : undefined

export function Studies({ query, onOpenProject, ref }: Props) {
  const [list, setList] = useState<CommunityStudy[] | null>(cachedList)
  const [error, setError] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError('')
    try {
      const studies = await window.humanstudy.community.studies()
      cachedList = studies
      setList(studies)
    } catch (e) {
      if (!cachedList) setList(null)
      setError(errorText(e, 'The library could not be loaded.'))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Retry quietly when the network comes back.
  useEffect(() => {
    const online = () => void load()
    window.addEventListener('online', online)
    return () => window.removeEventListener('online', online)
  }, [load])

  // Typing a search returns to the list.
  useEffect(() => {
    if (query) setOpenId(null)
  }, [query])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!list || !q) return list ?? []
    return list.filter((s) =>
      [s.title, s.description, s.authors.join(' '), String(s.year ?? '')].some((f) => f.toLowerCase().includes(q)),
    )
  }, [list, query])

  useImperativeHandle(ref, () => ({ openFirst: () => shown[0] && setOpenId(shown[0].id) }), [shown])

  if (openId) {
    const summary = list?.find((s) => s.id === openId) ?? null
    return <StudyPage id={openId} summary={summary} onBack={() => setOpenId(null)} onOpenProject={onOpenProject} />
  }

  const offline = typeof navigator !== 'undefined' && !navigator.onLine

  return (
    <div className="home-inner">
      <header className="lib-head">
        <div>
          <h1 className="lib-title">Studies</h1>
          <p className="muted lib-lead">Replicable human studies, built and checked by the community.</p>
        </div>
        <button className="lib-link" onClick={() => open(REPO_URL)}>
          Contribute on GitHub ↗
        </button>
      </header>

      {error && list && (
        <p className="lib-note small">
          {offline
            ? 'Offline — showing the last copy of the library.'
            : `Showing the last copy of the library. ${error}`}{' '}
          <button className="link" onClick={() => void load()}>
            Retry
          </button>
        </p>
      )}

      {!list && !error ? (
        <ul className="study-list" aria-busy="true" aria-label="Loading studies">
          {[0, 1, 2].map((i) => (
            <li key={i} className="study-card skeleton">
              <i />
              <i />
              <i />
            </li>
          ))}
        </ul>
      ) : !list ? (
        <div className="home-empty">
          <p>{offline ? 'You’re offline.' : 'The library could not be loaded.'}</p>
          <p className="muted small">{offline ? 'The studies load once you reconnect.' : error}</p>
          <button className="ghost lib-retry" onClick={() => void load()}>
            Try again
          </button>
        </div>
      ) : shown.length === 0 ? (
        <div className="home-empty">
          <p className="muted">{query ? 'No study matches that search.' : 'The library is empty.'}</p>
        </div>
      ) : (
        <ul className="study-list">
          {shown.map((s) => (
            <li key={s.id}>
              <button className="study-card" onClick={() => setOpenId(s.id)}>
                <strong className="study-card-title">{s.title}</strong>
                <span className="muted small">{byline(s, 3)}</span>
                {s.description && <span className="study-card-desc">{s.description}</span>}
                <Contributors people={s.contributors} compact />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Contributors({ people, compact }: { people: CommunityStudy['contributors']; compact?: boolean }) {
  if (people.length === 0)
    return <span className={`muted small ${compact ? 'study-card-foot' : ''}`}>No contributors yet — be the first</span>
  if (compact)
    return (
      <span className="study-card-foot avatars">
        {people.slice(0, 6).map((c) => (
          <Avatar key={c.github ?? c.name} name={c.name} src={contributorAvatar(c)} size={20} />
        ))}
        {people.length > 6 && <span className="muted small">+{people.length - 6}</span>}
      </span>
    )
  return (
    <ul className="people">
      {people.map((c) => (
        <li key={c.github ?? c.name}>
          {c.github ? (
            <button className="person" onClick={() => open(`https://github.com/${encodeURIComponent(c.github!)}`)}>
              <Avatar name={c.name} src={contributorAvatar(c)} size={26} />
              <span>{c.name}</span>
              <span className="muted small">@{c.github}</span>
            </button>
          ) : (
            <span className="person">
              <Avatar name={c.name} size={26} />
              <span>{c.name}</span>
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}

type Tab = 'overview' | 'materials' | 'activity'

function StudyPage({
  id,
  summary,
  onBack,
  onOpenProject,
}: {
  id: string
  summary: CommunityStudy | null
  onBack(): void
  onOpenProject(dir: string): void
}) {
  const [detail, setDetail] = useState<CommunityStudyDetail | null>(null)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<Tab>('overview')
  const [forking, setForking] = useState(false)
  const [forkError, setForkError] = useState('')
  useEffect(() => track('community.study_opened', { target: id }), [id])

  const load = useCallback(async () => {
    setError('')
    try {
      setDetail(await window.humanstudy.community.study(id))
    } catch (e) {
      setError(errorText(e, 'This study could not be loaded.'))
    }
  }, [id])

  useEffect(() => {
    setDetail(null)
    void load()
  }, [load])

  useEffect(() => {
    const keys = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (e.key === 'Escape' && !target?.closest('input, textarea')) onBack()
    }
    window.addEventListener('keydown', keys)
    return () => window.removeEventListener('keydown', keys)
  }, [onBack])

  const fork = async () => {
    setForking(true)
    setForkError('')
    try {
      onOpenProject(await window.humanstudy.community.fork(id))
    } catch (e) {
      setForkError(errorText(e, 'The study could not be copied.'))
      setForking(false)
    }
  }

  const head = detail ?? summary
  const files = useMemo(() => [...(detail?.files ?? [])].sort((a, b) => a.path.localeCompare(b.path)), [detail])

  return (
    <div className="home-inner study-page">
      <button className="lib-back" onClick={onBack}>
        ‹ All studies
      </button>

      <header className="repo-head">
        <div className="repo-id">
          <h1 className="repo-title">{head?.title ?? 'Loading…'}</h1>
          {head && <p className="muted repo-byline">{byline(head)}</p>}
        </div>
        <div className="repo-actions">
          <div className="repo-buttons">
            <button className="primary" onClick={() => void fork()} disabled={forking || !head}>
              {forking ? 'Copying…' : 'Fork to my projects'}
            </button>
            <button className="outline" onClick={() => detail && open(detail.repoUrl)} disabled={!detail}>
              Open on GitHub ↗
            </button>
            <button className="outline" onClick={() => detail && open(detail.discussionsUrl)} disabled={!detail}>
              Discuss ↗
            </button>
          </div>
          <p className="muted small repo-note">
            Copies the paper and materials into a new local project; the agent then builds its Human Program.
          </p>
          {forkError && <p className="home-error repo-error">{forkError}</p>}
        </div>
      </header>

      <nav className="tabs repo-tabs" role="tablist">
        {(['overview', 'materials', 'activity'] as Tab[]).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={`tab ${tab === t ? 'active' : ''}`}
            onClick={() => {
              if (t !== tab) track('tab.switch', { target: `study:${t}` })
              setTab(t)
            }}
          >
            {t === 'overview' ? 'Overview' : t === 'materials' ? 'Materials' : 'Activity'}
            {t === 'materials' && detail && <span className="tab-count">{detail.files.length}</span>}
          </button>
        ))}
      </nav>

      <section className="repo-body" role="tabpanel">
        {error ? (
          <div className="home-empty">
            <p>{!navigator.onLine ? 'You’re offline.' : 'This study could not be loaded.'}</p>
            <p className="muted small">{error}</p>
            <button className="ghost lib-retry" onClick={() => void load()}>
              Try again
            </button>
          </div>
        ) : tab === 'overview' ? (
          <div className="overview">
            <h2 className="home-label">About</h2>
            {head?.description ? (
              <p className="overview-desc">{head.description}</p>
            ) : (
              <p className="muted">No description.</p>
            )}
            <h2 className="home-label">Contributors</h2>
            {head && <Contributors people={head.contributors} />}
          </div>
        ) : !detail ? (
          <p className="muted small">Loading…</p>
        ) : tab === 'materials' ? (
          files.length === 0 ? (
            <p className="muted">No files in this study yet.</p>
          ) : (
            <ul className="repo-files">
              {files.map((f) => (
                <li key={f.path}>
                  <button onClick={() => open(f.url)} title={`Open ${f.path}`}>
                    <span className="file-glyph" aria-hidden />
                    <code className="repo-path">
                      {f.path.includes('/') && (
                        <span className="muted">{f.path.slice(0, f.path.lastIndexOf('/') + 1)}</span>
                      )}
                      {f.path.slice(f.path.lastIndexOf('/') + 1)}
                    </code>
                    <span className="muted small repo-size">{formatSize(f.size)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : detail.activity.length === 0 ? (
          <p className="muted">No recent changes.</p>
        ) : (
          <ul className="repo-commits">
            {detail.activity.map((c) => (
              <li key={c.sha}>
                <button onClick={() => open(c.url)} title="Open commit on GitHub">
                  <Avatar name={c.author} src={c.avatarUrl} size={24} />
                  <span className="commit-main">
                    <span className="commit-msg">{c.message.split('\n')[0]}</span>
                    <span className="muted small">
                      {c.author} · {relativeTime(c.date)}
                    </span>
                  </span>
                  <code className="muted small commit-sha">{c.sha.slice(0, 7)}</code>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
