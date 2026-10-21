// Community library: studies published in the public HumanStudy-Bench repo on GitHub.
// No electron imports here (the cache folder and project factory are passed in), so this
// module can be exercised from plain Node.
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CommunityStudy, CommunityStudyDetail } from '../preload/types'

const OWNER_REPO = 'HumanStudy-Hub/HumanStudy-Bench'
const BRANCH = process.env.HUMANSTUDY_COMMUNITY_BRANCH || 'main'
const RAW = `https://raw.githubusercontent.com/${OWNER_REPO}/${BRANCH}`
const API = `https://api.github.com/repos/${OWNER_REPO}`
const INDEX_URL = `${RAW}/co_website/data/studies_index.json`
const RESEARCH_INDEX_URL = `${RAW}/co_website/data/research_index.json`
const REPO_URL = `https://github.com/${OWNER_REPO}`
const DISCUSSIONS_URL = `${REPO_URL}/discussions`
const TTL_MS = 10 * 60 * 1000
const TIMEOUT_MS = 15_000
const ID_RE = /^(study_\d{3,}|paper_[a-f0-9]{24})$/

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
    aliases: Array.isArray(o.aliases) ? o.aliases.filter((v): v is string => typeof v === 'string') : [],
    legacyStudyId: typeof o.legacyStudyId === 'string' && /^study_\d{3,}$/.test(o.legacyStudyId) ? o.legacyStudyId : undefined,
    searchText: typeof o.searchText === 'string' ? o.searchText : '',
    conceptLabels: Array.isArray(o.conceptLabels) ? o.conceptLabels.filter((v): v is string => typeof v === 'string') : [],
    searchAliases: Array.isArray(o.searchAliases) ? o.searchAliases.filter((v): v is string => typeof v === 'string') : [],
    currentRevision: typeof o.currentRevision === 'string' ? o.currentRevision : null,
    assetRoot: typeof o.assetRoot === 'string' ? o.assetRoot : undefined,
    assetFiles: Array.isArray(o.assetFiles) ? o.assetFiles as CommunityStudy['assetFiles'] : undefined,
    capabilities: o.capabilities && typeof o.capabilities === 'object' ? o.capabilities as Record<string, boolean> : undefined,
    resources: Array.isArray(o.resources) ? o.resources as CommunityStudy['resources'] : undefined,
  }
}

// ---- studies() ------------------------------------------------------------------------
async function refreshIndex(): Promise<CommunityStudy[]> {
  if (indexInFlight) return indexInFlight
  indexInFlight = (async () => {
    let data: { studies?: unknown; papers?: unknown; taxonomy?: { concepts?: { id: string; label: string; aliases: string[]; status: string }[] } }
    try { data = await getJson(RESEARCH_INDEX_URL) as typeof data }
    catch { data = await getJson(INDEX_URL) as typeof data }
    const concepts = data.taxonomy?.concepts ?? []
    const list = Array.isArray(data?.papers) ? data.papers.map(raw => {
      const paper = raw as Record<string, unknown>
      const ids = Array.isArray(paper.conceptIds) ? paper.conceptIds : []
      const text = [paper.title, paper.description, paper.searchText].join('\n').normalize('NFKC').toLocaleLowerCase('en')
      return { ...paper, conceptLabels: concepts.filter(c => c.status === 'reviewed' && ids.includes(c.id)).flatMap(c => [c.label, ...c.aliases]),
        searchAliases: concepts.filter(c => c.status === 'reviewed' && c.label.toLocaleLowerCase('en').split(/\s+/).every(word => text.includes(word))).flatMap(c => [c.label, ...c.aliases]) }
    }) : Array.isArray(data?.studies) ? data.studies : []
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

function safeRelative(path: string): boolean {
  return !!path && !path.includes('\\') && !path.includes('\0') && !path.includes(':') && path.split('/').every(p => p !== '' && p !== '.' && p !== '..')
}

function assetRoot(id: string, entry: CommunityStudy | null): string {
  const root = entry?.assetRoot || `studies/${entry?.legacyStudyId || id}`
  if (!/^studies\/study_\d{3,}$/.test(root) && !/^community\/[A-Za-z0-9_.-]+\/revisions\/[a-f0-9]{64}$/.test(root))
    throw new Error('This entry has no verified downloadable research assets yet.')
  return root
}

async function listFiles(id: string, entry: CommunityStudy | null, ref = BRANCH): Promise<Detail['files']> {
  const files: Detail['files'] = []
  if (!entry?.assetRoot && !entry?.legacyStudyId && id.startsWith('paper_')) return files
  const root = assetRoot(id, entry)
  if (entry?.currentRevision) {
    if (!entry.assetFiles?.length || !root.endsWith('/' + entry.currentRevision)) throw new Error('The recommended revision manifest is unavailable.')
    return entry.assetFiles.map(file => {
      if (!safeRelative(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid immutable asset manifest.')
      return { path: file.path, size: file.bytes, url: `https://raw.githubusercontent.com/${OWNER_REPO}/${ref}/${root}/${file.path.split('/').map(encodeURIComponent).join('/')}` }
    })
  }
  const walk = async (rel: string): Promise<void> => {
    const items = (await getJson(`${API}/contents/${rel}?ref=${ref}`)) as ContentItem[]
    if (!Array.isArray(items)) return
    const subdirs: string[] = []
    for (const it of items) {
      const inner = it.path.slice(`${root}/`.length)
      if (it.type === 'file') files.push({ path: inner, size: it.size, url: it.download_url ?? '' })
      else if (it.type === 'dir' && (inner === 'source' || inner === 'source/materials')) subdirs.push(it.path)
    }
    for (const d of subdirs) await walk(d)
  }
  await walk(root)
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

async function listActivity(id: string, entry: CommunityStudy | null): Promise<Detail['activity']> {
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
  if (id.startsWith('paper_') && !entry?.assetRoot && !entry?.legacyStudyId) return []
  const rows = (await getJson(`${API}/commits?path=${assetRoot(id,entry)}&sha=${BRANCH}&per_page=10`)) as CommitRow[]
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
    repoUrl: `${REPO_URL}/tree/${BRANCH}/${entry?.assetRoot || `studies/${entry?.legacyStudyId || id}`}`,
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
    const sha = await mainSha()
    const [files, activity] = await Promise.all([listFiles(id, entry, sha || BRANCH), listActivity(id, entry)])
    const detail: Detail = { ...bare(id, entry), files, activity, sourceCommit: sha || undefined }
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
  const sha = detail.sourceCommit || await mainSha()
  if (!sha) throw new Error('The source version could not be pinned. Retry when GitHub is available.')
  if (detail.currentRevision) {
    const root = assetRoot(id, detail)
    const manifestIdentity = createHash('sha256').update(JSON.stringify((detail.assetFiles || []).map(file => ({ path: file.path, sha256: file.sha256 })))).digest('hex')
    if (manifestIdentity !== detail.currentRevision) throw new Error('The research revision manifest is invalid. No project was created.')
    const assets = await Promise.all((detail.assetFiles || []).map(async file => {
      if (!safeRelative(file.path)) throw new Error('Invalid research asset path.')
      const parts = file.path.split('/')
      if (parts.some(p => ['.git','.opencode','.humanstudy','node_modules','threads','conversations'].includes(p.toLowerCase()) || p.toLowerCase().startsWith('.env')))
        throw new Error('A private project path was found in the research assets.')
      if (file.path !== 'program.json' && !['package','artifacts','sources'].includes(parts[0])) throw new Error('Unsupported research asset.')
      const url = `https://raw.githubusercontent.com/${OWNER_REPO}/${sha}/${root}/${parts.map(encodeURIComponent).join('/')}`
      const raw = Buffer.from(await (await get(url, '*/*')).arrayBuffer())
      if (raw.length !== file.bytes || createHash('sha256').update(raw).digest('hex') !== file.sha256) throw new Error('Research asset verification failed. No project was created.')
      return { path: file.path, raw }
    }))
    if (!assets.some(f => f.path === 'program.json')) throw new Error('The recommended program is unavailable.')
    const dir = await createProject({ name: detail.title })
    for (const file of assets) {
      const target = join(dir, ...file.path.split('/'))
      await mkdir(join(target, '..'), { recursive: true })
      await writeFile(target, file.raw)
    }
    const program = JSON.parse(assets.find(f => f.path === 'program.json')!.raw.toString('utf8'))
    const referenced = new Set<string>((program.evidence || []).map((e: { path?: string }) => e.path).filter((p: unknown): p is string => typeof p === 'string'))
    if (typeof program.source?.filename === 'string') referenced.add(program.source.filename)
    for (const original of referenced) {
      const parts = original.split('/')
      if (!safeRelative(original) || !/\.(json|txt|csv|tsv|pdf|png|jpe?g|svg)$/i.test(original)
        || ['package','artifacts','sources','schema','exports'].includes(parts[0])
        || parts.some(p => ['.git','.opencode','.humanstudy','node_modules','program.json','account.json','settings.json'].includes(p.toLowerCase()) || p.startsWith('.env'))) continue
      const matches = assets.filter(f => f.path.endsWith('/' + original))
      if (matches.length === 1) {
        await mkdir(join(dir, original, '..'), { recursive: true })
        await writeFile(join(dir, original), matches[0].raw)
        if (/\.pdf$/i.test(original) && original === program.source?.filename) await writeFile(join(dir, 'paper.pdf'), matches[0].raw)
      }
    }
    await mkdir(join(dir, 'sources'), { recursive: true })
    const context = JSON.stringify({ ...detail, commit: sha, baseRevision: detail.currentRevision, forkedAt: new Date().toISOString() }, null, 2) + '\n'
    await mkdir(join(dir, '.humanstudy'), { recursive: true })
    await writeFile(join(dir, '.humanstudy/community.json'), context)
    if (!assets.some(f => f.path === 'sources/study.json')) await writeFile(join(dir, 'sources/study.json'), context)
    return dir
  }
  const dir = await createProject({ name: detail.title || id })
  const sources = join(dir, 'sources')
  await mkdir(join(sources, 'materials'), { recursive: true })

  const legacyId = detail.legacyStudyId || id
  const fileUrl = (f: Detail['files'][number]): string => `https://raw.githubusercontent.com/${OWNER_REPO}/${sha}/studies/${legacyId}/${f.path.split('/').map(encodeURIComponent).join('/')}`
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
    if (await download(`https://raw.githubusercontent.com/${OWNER_REPO}/${sha}/studies/${legacyId}/source/${name}`, join(sources, name))) notes.push(`- sources/${name} ← studies/${id}/source/${name}`)
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
