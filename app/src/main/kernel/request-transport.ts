// Bound the actual UTF-8 HTTP body, independently of the model's token window.
// Only outgoing copies change: native history and complete source bytes stay intact.
import { createServer } from 'node:http'
import { randomBytes, createHash } from 'node:crypto'
import { mkdirSync, realpathSync, writeFileSync, readFileSync, lstatSync } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** Trigger: an outgoing body above this is never sent. Below both the application (~4 MB) and
 *  hosting (4.5 MB) limits, with headroom. */
export const REQUEST_BYTES = 3_600_000
/** Target: once the trigger is crossed, the oldest media are archived until the body is back at
 *  or below this. Later turns then append without moving the cut until they add another
 *  REQUEST_BYTES - REQUEST_TARGET_BYTES (1.6 MB, roughly 5-10 rendered pages) of history, so the
 *  replaced prefix, and the provider's prompt cache with it, stays byte-identical between cuts.
 *  The same trigger/target hysteresis as upstream OpenCode's boundImages (25 MiB -> 15 MiB). */
export const REQUEST_TARGET_BYTES = 2_000_000
const RECEIVE_BYTES = 64 * 1024 * 1024
const ARCHIVE_DIR = '.humanstudy/tmp/request-archive'
type Json = Record<string, any>
export interface RequestBudget { trigger: number; target: number }
const DEFAULT_BUDGET: RequestBudget = { trigger: REQUEST_BYTES, target: REQUEST_TARGET_BYTES }

const verified = new Set<string>()
/** Content-addressed copy under the project; returns a project-relative, forward-slash path the
 *  kernel's read tool resolves on every platform (and that never reveals the user's home path). */
function archive(project: string, bytes: Buffer, extension: string): string {
  const root = realpathSync(project)
  const folder = join(root, ...ARCHIVE_DIR.split('/'))
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  const rel = relative(root, realpathSync(folder))
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) throw new Error('Request archive must remain inside the project.')
  const name = createHash('sha256').update(bytes).digest('hex') + extension
  const target = join(folder, name)
  // Same history => same names, so repeated requests never rewrite (or re-verify) unchanged files.
  if (verified.has(target) && lstatSync(target, { throwIfNoEntry: false })?.size === bytes.length) return `${ARCHIVE_DIR}/${name}`
  try { writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (!lstatSync(target).isFile() || !readFileSync(target).equals(bytes)) throw new Error('Request archive file is not a matching regular file.')
  }
  verified.add(target)
  return `${ARCHIVE_DIR}/${name}`
}

const MEDIA = /^data:(?:image\/(png|jpe?g|webp|gif)|application\/(pdf));base64,([\s\S]+)$/
function inlineMedia(part: Json): RegExpExecArray | null {
  const url = part?.type === 'image_url' ? part.image_url?.url : part?.type === 'file' ? part.file?.file_data : undefined
  return typeof url === 'string' ? MEDIA.exec(url) : null
}

function placeholderText(path: string, pdf: boolean): string {
  return pdf
    ? `[A PDF attachment was removed from this request to keep it under the size limit and is no longer visible to you. Do not make claims about contents you cannot currently see. The complete original PDF is saved at ${path} (relative to the project folder). Use hs-pdf pages on that file to extract page-marked text into a local file and read page ranges; render original pages or crops when visual verification is needed.]`
    : `[An image was removed from this request to keep it under the size limit and is no longer visible to you. Do not infer or recall details you cannot currently see. The complete original image is saved at ${path} (relative to the project folder); read that file again when visual verification is needed, or render a smaller page/crop if one image is too large.]`
}
const extension = (match: RegExpExecArray) => '.' + (match[1] || match[2])
function placeholder(project: string, match: RegExpExecArray): Json {
  return { type: 'text', text: placeholderText(archive(project, Buffer.from(match[3], 'base64'), extension(match)), !!match[2]) }
}
/** Exact placeholder size without hashing or writing: the name is always 64 hex chars + extension. */
const placeholderBytes = (match: RegExpExecArray) =>
  size({ type: 'text', text: placeholderText(`${ARCHIVE_DIR}/${'0'.repeat(64)}${extension(match)}`, !!match[2]) })

const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8')

/**
 * Bound the outgoing body with a stable hysteresis cut. Media are replayed in history order with a
 * running byte count (top-level fields first, then each message in turn); whenever that count
 * passes the trigger, the oldest still-inline media are archived until it is back at the target.
 * Each decision depends only on the request prefix up to that point, so the same history always
 * gives the same cut, and appending a turn cannot move the cut until the trigger is crossed again.
 * The newest visual evidence stays inline unless it alone cannot fit. Full originals stay local.
 */
export function fitRequest(raw: string, project: string, budget: RequestBudget = DEFAULT_BUDGET): { body: string; archived: number } {
  const { trigger, target } = budget
  if (Buffer.byteLength(raw, 'utf8') <= trigger) return { body: raw, archived: 0 }
  const body = JSON.parse(raw) as Json
  const messages: Json[] = Array.isArray(body.messages) ? body.messages : []
  const evicted = new Set<Json>() // parts chosen for replacement
  const inline: { part: Json; saved: number }[] = []
  let kept = size({ ...body, messages: [] })
  for (const message of messages) {
    kept += size(message) + 1
    if (Array.isArray(message.content)) for (const part of message.content) {
      const match = inlineMedia(part)
      if (!match) continue
      inline.push({ part, saved: size(part) - placeholderBytes(match) })
    }
    if (kept <= trigger) continue
    // Oldest first, but keep the newest media inline while anything older remains.
    let next = inline.findIndex(item => !evicted.has(item.part))
    while (kept > target && next >= 0 && next < inline.length - 1) {
      evicted.add(inline[next].part); kept -= inline[next].saved
      next++
    }
    if (kept > trigger && next >= 0 && next === inline.length - 1 && !evicted.has(inline[next].part)) {
      evicted.add(inline[next].part); kept -= inline[next].saved
    }
  }
  let archived = 0
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    message.content = message.content.map((part: Json) => {
      if (!evicted.has(part)) return part
      archived++
      return placeholder(project, inlineMedia(part)!)
    })
  }
  let bytes = size(body)
  if (bytes <= trigger) return { body: JSON.stringify(body), archived }
  // Large historical tool results can also exceed a byte budget. Preserve the complete text,
  // including its last character, and leave explicit read-back instructions. Never edit prompts,
  // assistant decisions, tool call IDs/arguments, or the latest tool result.
  const lastTool = messages.reduce((last, message, index) => message.role === 'tool' ? index : last, -1)
  for (let index = 0; index < lastTool; index++) {
    const message = messages[index]
    if (message.role !== 'tool' || typeof message.content !== 'string' || Buffer.byteLength(message.content) < 64_000) continue
    const path = archive(project, Buffer.from(message.content, 'utf8'), '.txt')
    const replacement = `[Complete tool result retained at ${path} (relative to the project folder). Read this file in ranges as needed; no source text has been truncated or summarized.]`
    bytes += size(replacement) - size(message.content)
    message.content = replacement
    archived++
    if (bytes <= trigger) return { body: JSON.stringify(body), archived }
  }
  throw new Error('The model request still exceeds the transport limit after preserving attachments locally. Read source files in page ranges or smaller crops, or compact the conversation. Saved files and native history are unchanged.')
}

function payloadError(status: number, headers: Headers, text: string): boolean {
  return status === 413 && (headers.get('x-vercel-error') === 'FUNCTION_PAYLOAD_TOO_LARGE' || /request (?:entity )?too large|payload too large|FUNCTION_PAYLOAD_TOO_LARGE/i.test(text))
}

export async function startRequestTransport(options: { project: string; upstream: string; key: string; bypass?: string; onAdjust?: (count: number) => void }) {
  const token = randomBytes(24).toString('base64url')
  const active = new Set<AbortController>()
  const server = createServer(async (req, res) => {
    const fail = (message: string, code = 'humanstudy_request_body_too_large') => {
      if (res.headersSent) { res.destroy(); return }
      // 400 + a distinct code prevents the pinned kernel treating a byte-size failure as a
      // context-token overflow and repeatedly attempting an ineffective model compaction.
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message, type: 'invalid_request_error', code } }))
    }
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return }
    const abort = new AbortController()
    active.add(abort)
    res.once('close', () => abort.abort())
    try {
      const chunks: Buffer[] = []
      let received = 0
      for await (const chunk of req) {
        received += chunk.length
        if (received > RECEIVE_BYTES) { fail('The local model request exceeds the 64 MB safety limit. Read fewer source pages at a time.'); return }
        chunks.push(chunk)
      }
      const raw = Buffer.concat(chunks).toString('utf8')
      let fitted: ReturnType<typeof fitRequest>
      try { fitted = fitRequest(raw, options.project) }
      catch (error) { fail(error instanceof Error ? error.message : 'Could not prepare source context.'); return }
      if (fitted.archived) options.onAdjust?.(fitted.archived)
      const send = (body: string) => fetch(options.upstream.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST', headers: { authorization: `Bearer ${options.key}`, 'content-type': 'application/json', ...(options.bypass ? { 'x-vercel-protection-bypass': options.bypass } : {}) }, body, signal: abort.signal,
      })
      let response = await send(fitted.body)
      if (response.status === 413) {
        const text = await response.text()
        if (!payloadError(response.status, response.headers, text)) {
          res.writeHead(413, { 'content-type': response.headers.get('content-type') ?? 'application/json' }); res.end(text); return
        }
        // One real adjustment, never a blind resend. A smaller upstream deployment limit can
        // change independently of the app; retry only if the serialized body actually shrank.
        let reduced: ReturnType<typeof fitRequest>
        const trigger = Math.min(1_800_000, Buffer.byteLength(fitted.body) - 1)
        try { reduced = fitRequest(fitted.body, options.project, { trigger, target: Math.floor(trigger * REQUEST_TARGET_BYTES / REQUEST_BYTES) }) }
        catch { fail('The gateway rejected the request size (upstream HTTP 413). No safe reduction remains; read smaller page ranges. Saved work is intact.'); return }
        if (!reduced.archived) { fail('The gateway rejected the request size. No safe reduction remains; read smaller page ranges.'); return }
        options.onAdjust?.(reduced.archived)
        fitted = reduced
        response = await send(fitted.body)
        if (response.status === 413) {
          const again = await response.text()
          if (payloadError(response.status, response.headers, again)) {
            fail('The gateway still rejected the adjusted request (upstream HTTP 413). Recovery stopped after one changed request; saved work is intact.'); return
          }
          res.writeHead(413, { 'content-type': response.headers.get('content-type') ?? 'application/json' }); res.end(again); return
        }
      }
      const headers: Record<string, string> = { 'content-type': response.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' }
      for (const name of ['retry-after', 'x-request-id', 'x-vercel-id']) {
        const value = response.headers.get(name)
        if (value) headers[name] = value
      }
      res.writeHead(response.status, headers)
      if (response.body) await pipeline(Readable.fromWeb(response.body as any), res)
      else res.end()
    } catch {
      if (!abort.signal.aborted) {
        if (res.headersSent) res.destroy()
        else {
          res.writeHead(502, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'The model gateway connection failed. Saved work is intact.', type: 'api_error', code: 'humanstudy_transport_error' } }))
        }
      }
    } finally { active.delete(abort) }
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  server.unref()
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Local model transport failed to bind.')
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`, token,
    close: () => { for (const abort of active) abort.abort(); server.closeAllConnections(); server.close() },
  }
}
