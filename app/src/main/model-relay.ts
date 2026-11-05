// A run owns one capability, one model, and a conservative total token reservation.
// Only this process holds upstream credentials. No package-controlled URL or headers are forwarded.
import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto'
import { mkdir, writeFile, realpath, open, unlink } from 'node:fs/promises'
import { constants, readFileSync, unlinkSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'

/** The only sandbox-exec the relay trusts; never looked up on PATH. */
export const SANDBOX_EXEC = '/usr/bin/sandbox-exec'
/** Relay + sandbox only where the OS can confine package code (macOS with its system sandbox-exec).
 *  Elsewhere simulations use the pre-relay path, where package code can read the user's key, and
 *  the run confirmation says so. Decided in the main process; nothing in a project can change it. */
export function relaySupported(platform: string = process.platform, exists: (path: string) => boolean = isFile): boolean {
  return platform === 'darwin' && exists(SANDBOX_EXEC)
}
function isFile(path: string): boolean {
  try { return statSync(path).isFile() } catch { return false }
}

/** Output limit reserved and forwarded when a request names none. The runtime client always sends
 *  one (default 512); this only bounds other callers. Reservation always equals the forwarded limit. */
export const DEFAULT_OUTPUT_TOKENS = 512
export const MAX_OUTPUT_TOKENS = 4096

export interface RelayOptions {
  project: string
  /** App-owned storage, outside the package/project write boundary. */
  storage: string
  onClose?(): void
  model: string
  upstream: string
  key: string
  bypass?: string
  /** Total reservation for the run; default 200,000 (see shared/run-limits.ts for the approved plan's). */
  tokenCap?: number
  /** Lifetime of the run capability in minutes; default 30. */
  expiryMinutes?: number
}
export const relayDescriptor = (storage: string, project: string) => join(storage, createHash('sha256').update(project).digest('hex') + '.json')

export async function startModelRelay(options: RelayOptions) {
  const token = randomBytes(32).toString('hex')
  const cap = options.tokenCap ?? 200_000
  const minutes = options.expiryMinutes ?? 30
  if (!options.model || !Number.isSafeInteger(cap) || cap <= 0 || !Number.isSafeInteger(minutes) || minutes <= 0 || minutes > 24 * 60) throw Error('Invalid run limits.')
  let reserved = 0
  const folder = options.storage
  const path = relayDescriptor(folder, options.project)
  await mkdir(folder, { recursive: true })
  const root = await realpath(options.project)
  if ((await realpath(folder)) === root || (await realpath(folder)).startsWith(root + sep)) throw Error('Run relay storage must be outside the project.')
  let finish = async () => {}
  let closed = false
  async function logUsage(entry: Record<string, unknown>) {
    const log = await open(path + '.usage.jsonl', constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
    try {
      const info = await log.stat()
      if (!info.isFile() || info.nlink !== 1) throw Error('Unsafe relay log.')
      await log.write(JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n')
    } finally { await log.close() }
  }
  const requests = new Set<AbortController>()
  const server = createServer(async (req, res) => {
    const fail = (status: number, message: string) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message } })) }
    const auth = Buffer.from(req.headers.authorization || '')
    const expected = Buffer.from(`Bearer ${token}`)
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) return fail(401, 'Invalid run token.')
    if (req.method === 'POST' && req.url === '/v1/run/complete') { res.end('{}'); setImmediate(() => void finish()); return }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return fail(404, 'Unsupported run endpoint.')
    const controller = new AbortController()
    requests.add(controller)
    try {
      let bytes = 0
      const chunks: Buffer[] = []
      for await (const part of req) {
        bytes += part.length
        if (bytes > 1_000_000) return fail(413, 'Run request is too large.')
        chunks.push(part)
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (body.model !== options.model || !Array.isArray(body.messages) || !body.messages.length || body.stream) return fail(400, 'Unsupported model or request.')
      const max = body.max_tokens ?? body.max_completion_tokens ?? DEFAULT_OUTPUT_TOKENS
      if (!Number.isSafeInteger(max) || max < 1 || max > MAX_OUTPUT_TOKENS) return fail(400, 'Output limit must be 1–4096 tokens.')
      // UTF-8 bytes upper-bound text tokens; extra framing reserve per message. Multimodal,
      // tools, external URLs and provider-specific routing cannot bypass the reservation.
      if (body.messages.some((m: any) => !m || !['system', 'user', 'assistant'].includes(m.role) || typeof m.content !== 'string')) return fail(400, 'Only text messages are supported.')
      const charge = bytes + 256 * body.messages.length + max
      if (reserved + charge > cap) return fail(402, 'Run token cap reached.')
      reserved += charge // synchronous: concurrent requests cannot oversubscribe; never refunded
      await logUsage({ event: 'reserved', model: options.model, reserved: charge })
      const outgoing = { model: options.model, messages: body.messages.map((m: any) => ({ role: m.role, content: m.content })), max_tokens: max,
        ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
        ...(Number.isSafeInteger(body.seed) ? { seed: body.seed } : {}) }
      const upstream = await fetch(options.upstream.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST', redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${options.key}`, ...(options.bypass ? { 'x-vercel-protection-bypass': options.bypass } : {}) },
        body: JSON.stringify(outgoing),
      })
      if (!upstream.ok) return fail(502, 'Model provider rejected the request.')
      const reply = await upstream.json() as any
      // Return only completion text and usage; upstream diagnostic fields cannot expose credentials.
      const choices = Array.isArray(reply.choices) ? reply.choices.map((c: any, index: number) => ({ index, message: { role: 'assistant', content: typeof c.message?.content === 'string' ? c.message.content : '' }, finish_reason: c.finish_reason })) : []
      const usage = Object.fromEntries(['prompt_tokens', 'completion_tokens', 'total_tokens'].map(k => [k, Number.isSafeInteger(reply.usage?.[k]) && reply.usage[k] >= 0 ? reply.usage[k] : 0]))
      const finish = choices.map((c: any) => typeof c.finish_reason === 'string' ? c.finish_reason.slice(0, 32) : null)
      await logUsage({ event: 'completed', model: options.model, reserved: charge, usage, finish_reason: finish[0] ?? null, truncated: finish.includes('length') })
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices, usage, model: options.model }))
    } catch { if (!res.headersSent) fail(502, 'Run model request failed.') }
    finally { requests.delete(controller) }
  })
  server.requestTimeout = 30_000
  server.headersTimeout = 10_000
  server.maxConnections = 16
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('Run relay unavailable.')
  const config = { baseURL: `http://127.0.0.1:${address.port}/v1`, token, model: options.model, tokenCap: cap }
  try { await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error }); await writeFile(path, JSON.stringify(config), { mode: 0o600, flag: 'wx' }) }
  catch (error) { server.close(); throw error }
  const expiry = setTimeout(() => void finish(), minutes * 60_000)
  expiry.unref()
  finish = async () => {
    if (closed) return
    closed = true; clearTimeout(expiry)
    for (const c of requests) c.abort()
    server.closeAllConnections(); server.close()
    try { if (JSON.parse(readFileSync(path, 'utf8')).token === token) unlinkSync(path) } catch { /* already removed or replaced */ }
    options.onClose?.()
  }
  return { ...config, close: finish }
}
