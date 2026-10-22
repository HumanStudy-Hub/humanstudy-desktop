// Bound the actual UTF-8 HTTP body, independently of the model's token window.
// Only outgoing copies change: native history and complete source bytes stay intact.
import { createServer } from 'node:http'
import { randomBytes, createHash } from 'node:crypto'
import { mkdirSync, realpathSync, writeFileSync, readFileSync, lstatSync } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export const REQUEST_BYTES = 3_600_000 // Below both the application and hosting limits, with headroom.
const RECEIVE_BYTES = 64 * 1024 * 1024
type Json = Record<string, any>

function archive(project: string, bytes: Buffer, extension: string): string {
  const root = realpathSync(project)
  const folder = join(root, '.humanstudy', 'tmp', 'request-archive')
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  const rel = relative(root, realpathSync(folder))
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) throw new Error('Request archive must remain inside the project.')
  const target = join(folder, createHash('sha256').update(bytes).digest('hex') + extension)
  try { writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (!lstatSync(target).isFile() || !readFileSync(target).equals(bytes)) throw new Error('Request archive file is not a matching regular file.')
  }
  return target
}

/** Full original media/tool results remain available via read, never silently sliced. */
export function fitRequest(raw: string, project: string, limit = REQUEST_BYTES): { body: string; archived: number } {
  if (Buffer.byteLength(raw, 'utf8') <= limit) return { body: raw, archived: 0 }
  const body = JSON.parse(raw) as Json
  let archived = 0
  let bytes = Buffer.byteLength(JSON.stringify(body), 'utf8')
  const messages: Json[] = body.messages ?? []
  // Prefer evicting the oldest media; keep the most recent visual evidence whenever it fits.
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    for (let index = 0; index < message.content.length; index++) {
      const part = message.content[index]
      const url = part.type === 'image_url' ? part.image_url?.url : part.type === 'file' ? part.file?.file_data : undefined
      if (typeof url !== 'string') continue
      const match = /^data:(?:image\/(png|jpe?g|webp|gif)|application\/(pdf));base64,([\s\S]+)$/.exec(url)
      if (!match) continue
      const path = archive(project, Buffer.from(match[3], 'base64'), '.' + (match[1] || match[2]))
      const replacement = { type: 'text', text: match[2]
        ? `[Full original PDF retained locally: ${path}. Binary PDF data is not repeated in outgoing context. Use hs-pdf pages on this file to extract complete page-marked text into a local file, then read page ranges; render original pages/crops when visual verification is needed. Do not infer unseen contents.]`
        : `[Full image retained locally: ${path}. This replaces a repeated image attachment in outgoing context only. Use read on this file when visual verification is needed; render a smaller page/crop if a single image exceeds the request limit. Do not infer unseen details.]` }
      bytes += Buffer.byteLength(JSON.stringify(replacement)) - Buffer.byteLength(JSON.stringify(part))
      message.content[index] = replacement
      archived++
      if (bytes <= limit) return { body: JSON.stringify(body), archived }
    }
  }
  // Large historical tool results can also exceed a byte budget. Preserve the complete text,
  // including its last character, and leave explicit read-back instructions. Never edit prompts,
  // assistant decisions, tool call IDs/arguments, or the latest tool result.
  const lastTool = messages.reduce((last, message, index) => message.role === 'tool' ? index : last, -1)
  for (let index = 0; index < lastTool; index++) {
    const message = messages[index]
    if (message.role !== 'tool' || typeof message.content !== 'string' || Buffer.byteLength(message.content) < 64_000) continue
    const path = archive(project, Buffer.from(message.content, 'utf8'), '.txt')
    const replacement = `[Complete tool result retained at ${path}. Read this file in ranges as needed; no source text has been truncated or summarized.]`
    bytes += Buffer.byteLength(JSON.stringify(replacement)) - Buffer.byteLength(JSON.stringify(message.content))
    message.content = replacement
    archived++
    if (bytes <= limit) return { body: JSON.stringify(body), archived }
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
        try { reduced = fitRequest(fitted.body, options.project, Math.min(1_800_000, Buffer.byteLength(fitted.body) - 1)) }
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
