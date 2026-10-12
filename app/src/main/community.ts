// Community library: studies published in the public HumanStudy-Bench repo on GitHub.
// No electron imports here (the cache folder and project factory are passed in), so this
// module can be exercised from plain Node.
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CommunityStudy, CommunityStudyDetail } from '../preload/types'

const OWNER_REPO = 'HumanStudy-Hub/HumanStudy-Bench'
const BRANCH = 'main'
const RAW = `https://raw.githubusercontent.com/${OWNER_REPO}/${BRANCH}`
const API = `https://api.github.com/repos/${OWNER_REPO}`
const INDEX_URL = `${RAW}/co_website/data/studies_index.json`
const REPO_URL = `https://github.com/${OWNER_REPO}`
const DISCUSSIONS_URL = `${REPO_URL}/discussions`
const TTL_MS = 10 * 60 * 1000
const TIMEOUT_MS = 15_000
const ID_RE = /^study_\d{3}$/

type Detail = CommunityStudyDetail
interface CacheFile {
  index?: { fetchedAt: number; studies: CommunityStudy[] }
  details?: Record<string, { fetchedAt: number; detail: Detail }>
}

let cacheDir: string | null = null
let cache: CacheFile | null = null
let indexInFlight: Promise<CommunityStudy[]> | null = null

/** Where community-cache.json lives (Electron's userData in the app). */
export function setCommunityCacheDir(dir: string): void {
  cacheDir = dir
  cache = null
}

function cachePath(): string | null {
  return cacheDir ? join(cacheDir, 'community-cache.json') : null
}

async function loadCache(): Promise<CacheFile> {
  if (cache) return cache
  const p = cachePath()
  cache = {}
  if (p && existsSync(p)) {
    try {
      cache = JSON.parse(await readFile(p, 'utf8')) as CacheFile
    } catch {
      cache = {}
    }
  }
  return cache
}

async function saveCache(): Promise<void> {
  const p = cachePath()
  if (!p || !cache || !cacheDir) return
  try {
    await mkdir(cacheDir, { recursive: true })
    await writeFile(p, JSON.stringify(cache))
  } catch {
    /* the cache is a convenience */
  }
}

class HttpError extends Error {
  constructor(
    public status: number,
    url: string
  ) {
    super(`GET ${url} -> HTTP ${status}`)
  }
}

async function get(url: string, accept = 'application/json'): Promise<Response> {
  const headers: Record<string, string> = { Accept: accept, 'User-Agent': 'HumanStudy-Desktop' }
  if (url.startsWith('https://api.github.com/')) headers['X-GitHub-Api-Version'] = '2022-11-28'
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) throw new HttpError(res.status, url)
  return res
}
const getJson = async (url: string): Promise<unknown> => (await get(url)).json()

// ---- normalization --------------------------------------------------------------------
const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v))

function normContributors(v: unknown): CommunityStudy['contributors'] {
  if (!Array.isArray(v)) return []
  const out: CommunityStudy['contributors'] = []
  for (const c of v) {
    if (typeof c === 'string') {
      const s = c.trim()
      if (!s) continue
      const gh = s.startsWith('@') ? s.slice(1) : undefined
      out.push(gh ? { name: gh, github: gh } : { name: s })
    } else if (c && typeof c === 'object') {
      const o = c as Record<string, unknown>
      const github =
        str(o.github ?? o.github_username ?? o.login)
          .trim()
          .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
          .replace(/^@/, '')
          .split(/[/?#]/)[0] || undefined
      const name = str(o.name).trim() || github
      if (!name) continue
      out.push(github ? { name, github } : { name })
    }
  }
  return out
}

function normStudy(raw: unknown): CommunityStudy | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const id = str(o.study_id ?? o.id).trim()
  if (!ID_RE.test(id)) return null
  const authors = Array.isArray(o.authors)
    ? o.authors.map((a) => str(a).trim()).filter(Boolean)
    : typeof o.authors === 'string'
      ? o.authors.split(/,\s*/).filter(Boolean)
      : []
  const y = typeof o.year === 'number' ? o.year : parseInt(str(o.year), 10)
  return {
    id,
    title: str(o.title).trim() || id,
    authors,
    year: Number.isFinite(y) ? y : null,
    description: str(o.description).trim(),
    contributors: normContributors(o.contributors),
  }
}

// ---- studies() ------------------------------------------------------------------------
async function refreshIndex(): Promise<CommunityStudy[]> {
  if (indexInFlight) return indexInFlight
  indexInFlight = (async () => {
    const data = (await getJson(INDEX_URL)) as { studies?: unknown }
    const list = Array.isArray(data?.studies) ? data.studies : Array.isArray(data) ? data : []
    const studies = list.map(normStudy).filter((s): s is CommunityStudy => s !== null)
    const c = await loadCache()
    c.index = { fetchedAt: Date.now(), studies }
    await saveCache()
    return studies
  })().finally(() => {
    indexInFlight = null
  })
  return indexInFlight
}

/** The index; served from cache when present, refreshed in the background at most every 10 minutes. */
export async function communityStudies(): Promise<CommunityStudy[]> {
  const c = await loadCache()
  if (c.index) {
    if (Date.now() - c.index.fetchedAt > TTL_MS) void refreshIndex().catch(() => undefined)
    return c.index.studies
  }
  try {
    return await refreshIndex()
  } catch {
    return [] // offline with no cache
  }
}

async function indexEntry(id: string): Promise<CommunityStudy | null> {
  const list = await communityStudies()
  return list.find((s) => s.id === id) ?? null
}

// ---- study(id) ------------------------------------------------------------------------
function assertId(id: unknown): string {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error(`invalid study id: ${String(id)}`)
  return id
}

interface ContentItem {
  type: string
  path: string
  size: number
  download_url: string | null
}

async function listFiles(id: string): Promise<Detail['files']> {
  const files: Detail['files'] = []
  const walk = async (rel: string): Promise<void> => {
    const items = (await getJson(`${API}/contents/${rel}?ref=${BRANCH}`)) as ContentItem[]
    if (!Array.isArray(items)) return
    const subdirs: string[] = []
    for (const it of items) {
      const inner = it.path.slice(`studies/${id}/`.length)
      if (it.type === 'file') files.push({ path: inner, size: it.size, url: it.download_url ?? '' })
      else if (it.type === 'dir' && (inner === 'source' || inner === 'source/materials')) subdirs.push(it.path)
    }
    for (const d of subdirs) await walk(d)
  }
  await walk(`studies/${id}`)
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

async function listActivity(id: string): Promise<Detail['activity']> {
  interface Person {
    name?: string
    date?: string
  }
  interface CommitRow {
    sha?: string
    html_url?: string
    author?: { login?: string; avatar_url?: string } | null
    commit?: { message?: string; author?: Person; committer?: Person }
  }
  const rows = (await getJson(`${API}/commits?path=studies/${id}&sha=${BRANCH}&per_page=10`)) as CommitRow[]
  if (!Array.isArray(rows)) return []
  return rows.map((r) => ({
    sha: str(r.sha),
    message: str(r.commit?.message).split('\n')[0] ?? '',
    author: str(r.author?.login) || str(r.commit?.author?.name) || 'unknown',
    avatarUrl: r.author?.avatar_url ? str(r.author.avatar_url) : undefined,
    date: str(r.commit?.author?.date ?? r.commit?.committer?.date),
    url: str(r.html_url),
  }))
}

function bare(id: string, entry: CommunityStudy | null): Detail {
  return {
    ...(entry ?? { id, title: id, authors: [], year: null, description: '', contributors: [] }),
    files: [],
    activity: [],
    repoUrl: `${REPO_URL}/tree/${BRANCH}/studies/${id}`,
    discussionsUrl: DISCUSSIONS_URL,
  }
}

/** Detail for one study; cached for 10 minutes, never throws on rate limits or offline. */
export async function communityStudy(rawId: string): Promise<Detail> {
  const id = assertId(rawId)
  const c = await loadCache()
  const hit = c.details?.[id]
  if (hit && Date.now() - hit.fetchedAt < TTL_MS) return hit.detail
  const entry = await indexEntry(id)
  try {
    const [files, activity] = await Promise.all([listFiles(id), listActivity(id)])
    const detail: Detail = { ...bare(id, entry), files, activity }
    c.details = { ...(c.details ?? {}), [id]: { fetchedAt: Date.now(), detail } }
    await saveCache()
    return detail
  } catch {
    // 403/429 rate limit, 404, or offline: stale cache, else the index fields alone.
    if (hit) return entry ? { ...hit.detail, ...entry } : hit.detail
    return bare(id, entry)
  }
}

// ---- fork(id) -------------------------------------------------------------------------
async function download(url: string, to: string): Promise<boolean> {
  try {
    const buf = Buffer.from(await (await get(url, '*/*')).arrayBuffer())
    await writeFile(to, buf)
    return true
  } catch {
    return false
  }
}

async function mainSha(): Promise<string | null> {
  try {
    const sha = (await (await get(`${API}/commits/${BRANCH}`, 'application/vnd.github.sha')).text()).trim()
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null
  } catch {
    return null
  }
}

const rawUrl = (id: string, rel: string): string => `${RAW}/studies/${id}/${rel.split('/').map(encodeURIComponent).join('/')}`

/** Creates a local project from a community study and returns its directory. */
export async function forkCommunityStudy(
  rawId: string,
  createProject: (input: { name: string }) => Promise<string>
): Promise<string> {
  const id = assertId(rawId)
  const detail = await communityStudy(id)
  const sha = await mainSha()
  const dir = await createProject({ name: detail.title || id })
  const sources = join(dir, 'sources')
  await mkdir(join(sources, 'materials'), { recursive: true })

  const fileUrl = (f: Detail['files'][number]): string => f.url || rawUrl(id, f.path)
  const notes: string[] = []

  const pdf = detail.files.find((f) => /^source\/[^/]+\.pdf$/i.test(f.path))
  if (pdf) {
    if (await download(fileUrl(pdf), join(dir, 'paper.pdf'))) notes.push(`- paper.pdf ← studies/${id}/${pdf.path}`)
    else notes.push(`- paper.pdf: download of studies/${id}/${pdf.path} failed`)
  } else notes.push('- paper.pdf: no PDF found in source/ (or the file listing was unavailable)')

  const materials = detail.files.filter((f) => /^source\/materials\/[^/]+\.json$/i.test(f.path))
  let got = 0
  for (const m of materials) {
    const name = m.path.split('/').pop() as string
    if (await download(fileUrl(m), join(sources, 'materials', name))) got++
  }
  notes.push(`- sources/materials/: ${got} of ${materials.length} JSON file(s) from studies/${id}/source/materials/`)

  // raw.githubusercontent.com is not rate limited like the API, so try these directly.
  for (const name of ['metadata.json', 'specification.json']) {
    if (await download(rawUrl(id, `source/${name}`), join(sources, name))) notes.push(`- sources/${name} ← studies/${id}/source/${name}`)
  }

  const entry = (await indexEntry(id)) ?? {
    id: detail.id,
    title: detail.title,
    authors: detail.authors,
    year: detail.year,
    description: detail.description,
    contributors: detail.contributors,
  }
  await writeFile(
    join(sources, 'study.json'),
    JSON.stringify({ ...entry, repoUrl: detail.repoUrl, forkedAt: new Date().toISOString(), commit: sha }, null, 2) + '\n'
  )

  const readme = [
    `# Forked from the HumanStudy community library`,
    '',
    `Study: **${detail.title}** (\`${id}\`)`,
    '',
    `- Source: ${detail.repoUrl}`,
    `- Repository: ${REPO_URL} (branch \`${BRANCH}\`)`,
    sha ? `- Commit of \`${BRANCH}\` at fork time: [\`${sha.slice(0, 7)}\`](${REPO_URL}/tree/${sha}/studies/${id})` : '- Commit at fork time: unknown (GitHub API unavailable)',
    `- Forked: ${new Date().toISOString()}`,
    '',
    '## Files',
    '',
    ...notes,
    '- sources/study.json: the library index entry for this study',
    '',
    'program.json is not included; the agent builds it from these sources.',
    '',
  ].join('\n')
  await writeFile(join(sources, 'README.md'), readme)
  return dir
}

// ---- openExternal ---------------------------------------------------------------------
const EXTERNAL_HOSTS = new Set(['github.com', 'raw.githubusercontent.com', 'humanstudy-hub.org', 'www.humanstudy-hub.org'])
export function isAllowedExternal(url: unknown): url is string {
  if (typeof url !== 'string') return false
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && EXTERNAL_HOSTS.has(u.hostname) && !u.username && !u.password
  } catch {
    return false
  }
}
