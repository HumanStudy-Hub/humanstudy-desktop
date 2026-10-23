// Electron-free, account-owned collection used by desktop and the headless worker. Originals are
// persisted privately before delivery, split into 4 MiB objects, and never pruned or truncated.
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, readdir, rename, stat, writeFile, unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import { CONTENT_BUCKET, EVENTS, LIMITS, MANIFEST_FORMAT, scrubResearchString, scrubResearchValue, validateResearchEvent, type ResearchEvent, type ResearchContentRow, type ContentRef } from '../shared/research-contract'

export const SOURCE_CONSENT_VERSION = 3
export interface ResearchAuth { supabaseUrl: string; supabaseKey: string; accessToken: string; userId: string }
type Surface = 'desktop' | 'headless'
interface Options {
  root: string
  surface: Surface
  appVersion: string
  auth(): Promise<ResearchAuth | null>
  allowed(): boolean
  /** Local signed-in identity, available offline; never a credential. */
  ownerId?(): string | null
  fetch?: typeof fetch
}
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export type ResearchCapture = Partial<ResearchEvent> & Pick<ResearchEvent, 'event_type'>
/** Causal columns a caller attaches to a captured version or import (see research-agent.ts). */
export interface CaptureLink { action_id?: string; caused_by?: string; thread_id?: string; tool_call_id?: string; metadata?: Record<string, unknown> }
const linkFields = (link?: CaptureLink) => link ? { ...(link.action_id ? { action_id: link.action_id } : {}), ...(link.caused_by ? { caused_by: link.caused_by } : {}),
  ...(link.thread_id ? { thread_id: link.thread_id } : {}), ...(link.tool_call_id ? { tool_call_id: link.tool_call_id } : {}) } : {}
async function json<T>(path: string): Promise<T | null> { try { return JSON.parse(await readFile(path, 'utf8')) } catch { return null } }
async function atomic(path: string, data: string | Uint8Array) {
  const tmp = `${path}.${randomUUID()}.tmp`
  try { await writeFile(tmp, data, { mode: 0o600 }); await rename(tmp, path) }
  finally { await unlink(tmp).catch(() => undefined) }
}

export function createResearchCollector(options: Options) {
  const fetcher = options.fetch ?? fetch
  let chain: Promise<unknown> = Promise.resolve(), flushing: Promise<void> | null = null
  let lastError: string | undefined
  const sessions = new Map<string, { id: string; seq: number; install: string }>()
  const run = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn); chain = next.catch(e => { lastError = e instanceof Error ? e.message : 'Research capture needs retry.' }); return next
  }
  async function identity(requireAgreement = true): Promise<ResearchAuth | null> {
    if (requireAgreement && !options.allowed()) return null
    const auth = await options.auth()
    if (!auth || !uuid.test(auth.userId)) return null
    const u = new URL(auth.supabaseUrl)
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname))) throw new Error('Invalid research service origin.')
    return auth
  }
  async function localOwner(): Promise<string | null> {
    if (!options.allowed()) return null
    const id = options.ownerId ? options.ownerId() : (await options.auth())?.userId
    return id && uuid.test(id) ? id : null
  }
  async function ownerDir(owner: string): Promise<string> {
    const root = join(options.root, owner)
    for (const dir of ['', 'events', 'content', 'rejected']) await mkdir(join(root, dir), { recursive: true, mode: 0o700 })
    return root
  }
  async function object(root: string, sha256: string, bytes: Uint8Array, row: ResearchContentRow) {
    const path = join(root, 'content', sha256)
    const prior = await json<ResearchContentRow>(path + '.json')
    if (prior) return // a previous whole object may also be reused as a part, and vice versa
    await atomic(path + '.bin', bytes)
    await atomic(path + '.json', JSON.stringify(row))
  }
  async function stageFile(root: string, path: string, mime: string): Promise<ContentRef> {
    const whole = createHash('sha256'), parts: Array<{ sha256: string; bytes: number }> = []
    let bytes = 0
    for await (const chunk of createReadStream(path, { highWaterMark: LIMITS.partBytes })) {
      const data = chunk as Buffer, sha256 = hash(data)
      whole.update(data); bytes += data.length; parts.push({ sha256, bytes: data.length })
      await object(root, sha256, data, { sha256, kind: 'part', bytes: data.length, stored_bytes: data.length, mime, encoding: 'identity', surface: options.surface })
    }
    const sha256 = whole.digest('hex')
    if (!parts.length) {
      const empty = gzipSync(Buffer.alloc(0))
      await object(root, sha256, empty, { sha256, kind: 'whole', bytes: 0, stored_bytes: empty.length, mime, encoding: 'gzip', surface: options.surface })
    }
    if (parts.length > 1) {
      const manifest = Buffer.from(JSON.stringify({ format: MANIFEST_FORMAT, encoding: 'bytes', bytes, sha256, mime, parts }))
      await object(root, sha256, manifest, { sha256, kind: 'manifest', bytes, stored_bytes: manifest.length, mime, encoding: 'identity', parts: parts.map(p => p.sha256), surface: options.surface })
    }
    return { role: 'source', sha256, bytes, mime }
  }
  async function stageBytes(root: string, raw: Buffer, role: string): Promise<ContentRef> {
    const sha256 = hash(raw), parts: Array<{ sha256: string; bytes: number }> = []
    for (let i = 0; i < raw.length || i === 0; i += LIMITS.partBytes) {
      const bytes = raw.subarray(i, i + LIMITS.partBytes), part = hash(bytes), compressed = gzipSync(bytes)
      await object(root, part, compressed, { sha256: part, kind: 'part', bytes: bytes.length,
        stored_bytes: compressed.length, mime: 'text/plain', encoding: 'gzip', surface: options.surface })
      parts.push({ sha256: part, bytes: bytes.length })
    }
    if (parts.length > 1) {
      const manifest = Buffer.from(JSON.stringify({ format: MANIFEST_FORMAT, encoding: 'utf8', bytes: raw.length, sha256, mime: 'text/plain', parts }))
      await object(root, sha256, manifest, { sha256, kind: 'manifest', bytes: raw.length, stored_bytes: manifest.length,
        mime: 'text/plain', encoding: 'identity', parts: parts.map(p => p.sha256), surface: options.surface })
    }
    return { role, sha256, bytes: raw.length, mime: 'text/plain' }
  }
  async function enqueue(auth: Pick<ResearchAuth, 'userId'>, root: string, fields: Partial<ResearchEvent> & Pick<ResearchEvent, 'event_type' | 'data_type'>) {
    let session = sessions.get(auth.userId)
    if (!session) {
      const saved = await json<{ install: string }>(join(root, 'install.json'))
      session = { id: randomUUID(), seq: 0, install: saved?.install ?? randomUUID() }; sessions.set(auth.userId, session)
      await atomic(join(root, 'install.json'), JSON.stringify({ install: session.install }))
    }
    if (session.seq === 0 && fields.event_type !== 'session.start') await enqueue(auth, root, { event_type: 'session.start', data_type: 'session', metadata: { collection_mode: 'interaction-events' } })
    const row: ResearchEvent = {
      id: randomUUID(), contract_version: '1.0.0', surface: options.surface, install_id: session.install,
      research_session_id: session.id, client_seq: session.seq + 1, occurred_at: new Date().toISOString(),
      metadata: {}, content_refs: [], app_version: options.appVersion, collector_version: 'research-collector/1.0.0',
      consent_version: SOURCE_CONSENT_VERSION, platform: process.platform as 'darwin' | 'win32' | 'linux', ...fields,
    }
    const errors = validateResearchEvent(row)
    if (errors.length) throw new Error(`Invalid research event: ${errors.join('; ')}`)
    await atomic(join(root, 'events', row.id + '.json'), JSON.stringify(row))
    session.seq++
    return row.id
  }
  /** Persist one complete semantic event. Large values are referenced, never clipped. */
  function capture(fields: ResearchCapture, context: { projectDir?: string; email?: string | null } = {}): Promise<string | null> {
    const capturedOwner = localOwner() // bind at invocation, not when the serialized queue reaches it
    return run(async () => {
      const owner = await capturedOwner
      if (!owner || await localOwner() !== owner) return null
      const spec = EVENTS[fields.event_type]
      if (!spec) throw new Error('Unknown research event type: ' + fields.event_type)
      const root = await ownerDir(owner)
      const metadata = scrubResearchValue(fields.metadata ?? {}, context) as Record<string, unknown>
      const refs = [...(fields.content_refs ?? [])]
      for (const [key, value] of Object.entries(metadata)) {
        if (typeof value === 'string' && Buffer.byteLength(value) > LIMITS.inlineTextBytes) {
          const ref = await stageBytes(root, Buffer.from(value), key)
          refs.push(ref); delete metadata[key]
        }
      }
      // Preserve required keys and complete structured values, including long question/tool inputs.
      if (Buffer.byteLength(JSON.stringify(metadata)) > LIMITS.metadataBytes) {
        const ref = await stageBytes(root, Buffer.from(JSON.stringify(metadata)), 'metadata')
        refs.push(ref)
        for (const key of Object.keys(metadata)) {
          const value = metadata[key]
          if (!spec.metadata?.includes(key) && !spec.content?.includes(key)) delete metadata[key]
          else if (typeof value === 'object' && value !== null) metadata[key] = { content_ref: ref.sha256, key }
        }
      }
      if (await localOwner() !== owner) return null
      const id = fields.id ?? randomUUID()
      return enqueue({ userId: owner }, root, { ...fields, id, data_type: spec.dataType,
        ...(fields.target ? { target: scrubResearchString(fields.target, context) } : {}),
        ...(spec.primary ? { action_id: id } : {}), metadata, content_refs: refs })
    })
  }
  async function end(reason = 'closed'): Promise<void> {
    const owner = await localOwner(); if (!owner) return
    await run(async () => {
      const session = sessions.get(owner); if (!session) return
      await enqueue({ userId: owner }, await ownerDir(owner), { event_type: 'session.end', data_type: 'session',
        metadata: { reason, captured_through_seq: session.seq } })
      sessions.delete(owner)
    })
  }
  /** Version generated files; sanitize text, preserve opaque bytes. Sources use queueSource. */
  /**
   * `snapshot` is the file's text read when its writer finished. Captures run in order behind
   * earlier ones, so without it a quick second write can replace the file before it is read and
   * the earlier version is never recorded.
   */
  function queueArtifact(path: string, projectId: string, artifactId: string, by: string, link?: CaptureLink | (() => CaptureLink), snapshot?: string): Promise<void> {
    const capturedOwner = localOwner()
    return run(async () => {
      const owner = await capturedOwner; if (!owner || await localOwner() !== owner) return
      const root = await ownerDir(owner), before = snapshot === undefined ? await stat(path) : undefined
      if (before && !before.isFile()) return
      const textFile = /\.(json|md|txt|csv|tsv|html?|py|r|js|ts|tex|bib|ya?ml|xml|svg|qmd|rmd|css|sql|jl|do|sps|ipynb|log|toml|ini)$/i.test(artifactId)
      const role = artifactId === 'program.json' ? 'program' : 'file'
      const projectDir = path.slice(0, -artifactId.length).replace(/[\\/]+$/, '')
      const ref = snapshot !== undefined
        ? await stageBytes(root, Buffer.from(scrubResearchString(snapshot, { projectDir })), role)
        : textFile
          ? await stageBytes(root, Buffer.from(scrubResearchString(await readFile(path, 'utf8'), { projectDir })), role)
          : await stageFile(root, path, 'application/octet-stream')
      if (before) {
        const after = await stat(path)
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) return
      }
      if (await localOwner() !== owner) return
      const receipt = join(root, `artifact-${hash(Buffer.from(projectId + ':' + artifactId))}.json`)
      const previous = await json<{ hash: string; version: number }>(receipt)
      if (previous?.hash === ref.sha256) return
      const version = (previous?.version ?? 0) + 1
      // Resolved when the version is known to be new, so the writer link is as fresh as the bytes.
      const resolved = typeof link === 'function' ? link() : link
      await enqueue({ userId: owner }, root, { event_type: artifactId === 'program.json' ? 'program.version' : 'artifact.version', data_type: 'knowledge_artifact',
        project_id: projectId, artifact_id: artifactId, artifact_version: version, ...linkFields(resolved),
        metadata: { ...resolved?.metadata, by, hash: ref.sha256 }, content_refs: [{ ...ref, role }] })
      await atomic(receipt, JSON.stringify({ hash: ref.sha256, version }))
    })
  }
  async function queueSource(path: string, projectId: string, mime = 'application/octet-stream', link?: CaptureLink): Promise<void> {
    const capturedOwner = localOwner()
    return run(async () => {
      const owner = await capturedOwner; if (!owner || await localOwner() !== owner) return
      const auth = { userId: owner }
      const info = await stat(path); if (!info.isFile()) return
      const root = await ownerDir(auth.userId), ref = await stageFile(root, path, mime)
      const after = await stat(path)
      if (info.size !== ref.bytes || info.mtimeMs !== after.mtimeMs || info.ino !== after.ino) throw new Error('Source changed during capture; waiting for a stable version.')
      const receipt = join(root, `source-${hash(Buffer.from(projectId + ':' + ref.sha256))}.json`)
      if (await json(receipt)) return
      // Recheck after file IO: signing out or switching accounts must never reattribute a source.
      if (await localOwner() !== auth.userId) return
      await enqueue(auth, root, { event_type: 'source.import', data_type: 'source_input', project_id: projectId,
        source_id: ref.sha256, ...linkFields(link), metadata: { ...link?.metadata, provenance: 'import', filename: scrubResearchString(basename(path)) }, content_refs: [ref] })
      await atomic(receipt, JSON.stringify({ sha256: ref.sha256 }))
    })
  }
  async function request(auth: ResearchAuth, path: string, init: RequestInit = {}) {
    return fetcher(auth.supabaseUrl.replace(/\/$/, '') + path, { ...init, signal: AbortSignal.timeout(20_000),
      headers: { apikey: auth.supabaseKey, Authorization: `Bearer ${auth.accessToken}`, ...init.headers } })
  }
  async function fresh(auth: ResearchAuth, requireAgreement = true): Promise<ResearchAuth> {
    const next = await identity(requireAgreement)
    if (!next || next.userId !== auth.userId) throw new Error('Research account changed; pending records remain with their original owner.')
    return next
  }
  async function upload(auth: ResearchAuth, root: string, sha: string, visiting = new Set<string>()): Promise<void> {
    if (visiting.has(sha)) throw new Error('Cyclic research content manifest.')
    visiting.add(sha)
    const row = await json<ResearchContentRow>(join(root, 'content', sha + '.json'))
    if (!row) throw new Error('Pending research content is missing locally.')
    if (row.kind === 'manifest') for (const part of row.parts ?? []) await upload(auth, root, part, new Set(visiting))
    auth = await fresh(auth)
    const seen = await request(auth, `/rest/v1/research_content?sha256=eq.${sha}&owner_id=eq.${auth.userId}&select=sha256&limit=1`)
    if (!seen.ok) throw new Error(`Research content check failed (${seen.status}).`)
    if ((await seen.json()).length) return
    const bytes = await readFile(join(root, 'content', sha + '.bin'))
    const raw = row.encoding === 'gzip' ? gunzipSync(bytes, { maxOutputLength: LIMITS.partBytes }) : bytes
    if (row.kind !== 'manifest' && (hash(raw) !== sha || raw.length !== row.bytes)) throw new Error('Local research content failed its hash check.')
    const url = `/storage/v1/object/${CONTENT_BUCKET}/${auth.userId}/${sha}`
    const uploaded = await request(auth, url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-upsert': 'false' }, body: new Uint8Array(bytes) })
    if (!uploaded.ok) {
      const error = await uploaded.json().catch(() => ({}))
      if (!(uploaded.status === 409 || error.statusCode === '409' || error.error === 'Duplicate')) throw new Error(`Research content upload failed (${uploaded.status}).`)
      // A duplicate is only accepted when this exact private object is readable.
      const existing = await request(auth, `/storage/v1/object/authenticated/${CONTENT_BUCKET}/${auth.userId}/${sha}`, { method: 'GET' })
      if (!existing.ok) throw new Error('Duplicate research object could not be confirmed.')
      const stored = Buffer.from(await existing.arrayBuffer())
      if (!stored.equals(bytes)) throw new Error('Existing research object has different bytes.')
    }
    auth = await fresh(auth)
    const saved = await request(auth, '/rest/v1/research_content?on_conflict=owner_id,sha256', { method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify(row) })
    if (!saved.ok) throw new Error(`Research content receipt failed (${saved.status}).`)
  }
  async function flush(): Promise<void> {
    if (flushing) return flushing
    flushing = (async () => {
      // Network waits never occupy the capture queue. A slow upload must not leave new user
      // interactions only in memory until a 20-second request timeout finishes.
      await chain
      let auth = await identity(); if (!auth) return
      const root = await ownerDir(auth.userId)
      const who = await request(auth, '/auth/v1/user')
      if (!who.ok || (await who.json()).id !== auth.userId) throw new Error('Could not verify the research account.')
      // allowed() is only true after the current explicit agreement. Never migrate older consent.
      const agreed = await request(auth, '/rest/v1/research_consents?on_conflict=owner_id,surface,version', { method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify({ surface: options.surface, version: SOURCE_CONSENT_VERSION, usage: true, content: true, sources: true }) })
      if (!agreed.ok) throw new Error(`Could not record the source agreement (${agreed.status}).`)
      let files = (await readdir(join(root, 'events'))).filter(f => f.endsWith('.json'))
      if (files.length) await run(async () => {
        const session = sessions.get(auth!.userId)
        if (!session) return
        await enqueue(auth!, root, { event_type: 'delivery.checkpoint', data_type: 'session', metadata: {
          captured_through_seq: session.seq, pending_events: files.length,
          pending_content: (await readdir(join(root, 'content'))).filter(f => f.endsWith('.json')).length } })
      })
      files = (await readdir(join(root, 'events'))).filter(f => f.endsWith('.json'))
      const pendingRows = await Promise.all(files.map(async file => ({ file, row: await json<ResearchEvent>(join(root, 'events', file)) })))
      pendingRows.sort((a, b) => (a.row?.research_session_id ?? '').localeCompare(b.row?.research_session_id ?? '') || (a.row?.client_seq ?? 0) - (b.row?.client_seq ?? 0))
      let rejection: string | undefined = (await readdir(join(root, 'rejected'))).length
        ? 'A rejected research record is retained locally for review.' : undefined
      for (const { file, row } of pendingRows) {
        if (!row) { rejection = 'A corrupt event was retained for local recovery.'; continue }
        for (const ref of row.content_refs) await upload(auth, root, ref.sha256)
        auth = await fresh(auth)
        const stored = await request(auth, '/rest/v1/research_events?on_conflict=id', { method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify(row) })
        if (!stored.ok) {
          if ([400, 413, 422].includes(stored.status)) {
            // Isolate exactly one rejected record; preserve its complete original and report the gap.
            await atomic(join(root, 'rejected', file), JSON.stringify({ row, status: stored.status, rejected_at: new Date().toISOString() }))
            await enqueue(auth, root, { event_type: 'delivery.rejected', data_type: 'session', metadata: {
              rejected_event_id: row.id, rejected_seq: row.client_seq, rejected_session_id: row.research_session_id, status: stored.status } })
            await unlink(join(root, 'events', file)); rejection = 'A rejected research record is retained locally for review.'
            continue
          }
          throw new Error(`Research event delivery failed (${stored.status}); retained locally.`)
        }
        await unlink(join(root, 'events', file))
      }
      // Only acknowledged content is eligible for local cleanup. Unsent bytes are never pruned.
      await run(async () => {
        if (!(await readdir(join(root, 'events'))).some(f => f.endsWith('.json')) && !(await readdir(join(root, 'rejected'))).length)
          for (const f of await readdir(join(root, 'content'))) await unlink(join(root, 'content', f))
      })
      lastError = rejection
    })().catch(e => { lastError = e instanceof Error ? e.message : 'Research upload failed.' }).finally(() => { flushing = null })
    return flushing
  }
  async function pending(): Promise<number> {
    const owner = await localOwner(); if (!owner) return 0
    const root = await ownerDir(owner)
    const rejected = (await readdir(join(root, 'rejected'))).filter(f => f.endsWith('.json')).length
    if (rejected) lastError = 'A rejected research record is retained locally for review.'
    return (await readdir(join(root, 'events'))).filter(f => f.endsWith('.json')).length + rejected
  }
  async function exportFiles(): Promise<Record<string, Uint8Array>> {
    if (flushing) await flushing
    const owner = options.ownerId ? options.ownerId() : (await options.auth())?.userId
    if (!owner || !uuid.test(owner)) return {}
    const root = await ownerDir(owner), files: Record<string, Uint8Array> = {}
    await run(async () => {
      for (const dir of ['events', 'content', 'rejected']) for (const f of await readdir(join(root, dir)))
        if (/^[a-f0-9-]+\.(json|bin)$/.test(f)) files[`research-v1/local/${dir}/${f}`] = await readFile(join(root, dir, f))
    })
    const auth = await identity(false); if (!auth || auth.userId !== owner) throw new Error('Sign in to the original account before exporting research data.')
    const who = await request(auth, '/auth/v1/user')
    if (!who.ok || (await who.json()).id !== owner) throw new Error('Could not verify the export account.')
    for (const table of ['research_events', 'research_content', 'research_consents']) {
      const rows: Record<string, unknown>[] = []
      for (let offset = 0; ; offset += 200) {
        const order = table === 'research_content' ? 'sha256' : table === 'research_consents' ? 'surface,version' : 'id'
        const response = await request(await fresh(auth, false), `/rest/v1/${table}?owner_id=eq.${owner}&select=*&order=${order}&limit=200&offset=${offset}`)
        if (response.status === 404) { files['research-v1/service-status.txt'] = Buffer.from('The new research schema is not deployed. Local pending records are included.'); break }
        if (!response.ok) throw new Error(`Research export failed (${response.status}); no incomplete export was saved.`)
        const page = await response.json() as Record<string, unknown>[]
        rows.push(...page); if (page.length < 200) break
      }
      files[`research-v1/${table}.json`] = Buffer.from(JSON.stringify(rows, null, 2))
      if (table === 'research_content') for (const row of rows) {
        if (typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.sha256)) throw new Error('Invalid content export reference.')
        const r = await request(await fresh(auth, false), `/storage/v1/object/authenticated/${CONTENT_BUCKET}/${owner}/${row.sha256}`)
        if (!r.ok) throw new Error('A referenced source could not be exported; no incomplete export was saved.')
        files[`research-v1/objects/${row.sha256}`] = new Uint8Array(await r.arrayBuffer())
      }
    }
    files['research-v1/README.txt'] = Buffer.from('Object metadata is in research_content.json. Decompress gzip objects before reading. For a manifest, decompress each part and concatenate in the declared order; then verify the original SHA-256. Original source bytes are preserved. verified_at distinguishes server-checked content from uploaded content.')
    return files
  }
  return { capture, end, queueSource, queueArtifact, flush, pending, exportFiles, error: () => lastError }
}
