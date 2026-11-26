import { semanticId } from '../shared/research-contract'
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
/** Text of one request (everything but its pictures), as before pictures were allowed. */
export const MAX_TEXT_BYTES = 1_000_000
/** Pictures (a run's `images`): data URLs of PNG, JPEG, GIF or WebP in user messages, at most this many per request,
 *  each at most MAX_IMAGE_BYTES of data URL, all together at most MAX_REQUEST_BYTES with the text. */
export const MAX_IMAGES = 8
/** Same caps as the hosted endpoint (humanstudy-hub-web lib/try-dev-model-budget.ts: 1,000,000 base64 bytes per
 *  picture, 4,000,000 bytes of request, the route's body limit under Vercel's 4.5 MB). */
export const MAX_IMAGE_BYTES = 1_000_000
export const MAX_REQUEST_BYTES = 4_000_000
/** Reserved per picture instead of its base64 bytes (a model bills a picture by its pixels; Claude models stay under
 *  this); skills/run/participants.py IMAGE_RESERVE_TOKENS, which budget.py counts, must say the same. */
export const IMAGE_RESERVE_TOKENS = 5000
/** Request bytes per reserved input token: conservative for English (about 4 bytes a token) and about one token a
 *  CJK character (6 bytes as \\uXXXX). skills/run/budget.py BYTES_PER_TOKEN must say the same. */
export const BYTES_PER_TOKEN = 3
/** What one call reserves before it runs: its text bytes / 3 (rounded up) + 256 per message + IMAGE_RESERVE_TOKENS per
 *  picture + its output limit. */
export const callReservation = (textBytes: number, messages: number, pictures: number, maxTokens: number): number =>
  Math.ceil(textBytes / BYTES_PER_TOKEN) + 256 * messages + IMAGE_RESERVE_TOKENS * pictures + maxTokens
/** The tokens a provider reports for a call, or null when it reports nothing usable: the call then keeps its
 *  reservation. prompt_tokens + completion_tokens when both are non-negative safe integers (total_tokens instead when
 *  it is larger); a valid total_tokens alone; never 0 while total_tokens is above 0. */
export function actualTokens(usage: any): number | null {
  const ok = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
  const total = ok(usage?.total_tokens) ? usage.total_tokens : null
  if (ok(usage?.prompt_tokens) && ok(usage?.completion_tokens)) {
    const sum = usage.prompt_tokens + usage.completion_tokens
    return total !== null && total > sum ? total : sum
  }
  return total !== null && total > 0 ? total : null
}
/** Admission: a call starts only if what is used, plus every call in flight at 1.5x its reservation, plus this
 *  call's reservation stays within ADMIT_SHARE of the cap. Actual spend can pass the cap only by the estimate error of
 *  calls already in flight beyond that headroom; once it does, no further call is admitted. */
export const ADMIT_SHARE = 0.95
export const IN_FLIGHT_FACTOR = 1.5
export const admits = (o: { used: number; outstanding: number; charge: number; cap: number }): boolean =>
  o.used + IN_FLIGHT_FACTOR * o.outstanding + o.charge <= ADMIT_SHARE * o.cap
const DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/

type Part = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
/** A message's content as the relay forwards it, or an error. Text everywhere; with `images`, a user message may be
 *  a list of text and image_url parts whose URL is an inline picture (never a remote URL, which the provider would
 *  fetch). Returns the content and the bytes of its pictures' URLs. */
export function relayContent(m: any, images: boolean): { content: string | Part[]; pictures: number; pictureBytes: number } | string {
  if (!m || !['system', 'user', 'assistant'].includes(m.role)) return 'Only text messages are supported.'
  if (typeof m.content === 'string') return { content: m.content, pictures: 0, pictureBytes: 0 }
  if (!images || m.role !== 'user' || !Array.isArray(m.content) || !m.content.length) return 'Only text messages are supported.'
  const parts: Part[] = []
  let pictureBytes = 0
  for (const p of m.content) {
    if (p?.type === 'text' && typeof p.text === 'string') parts.push({ type: 'text', text: p.text })
    else if (p?.type === 'image_url' && typeof p.image_url?.url === 'string') {
      const url: string = p.image_url.url
      if (!DATA_IMAGE.test(url)) return 'Pictures must be inline PNG, JPEG, GIF or WebP images.'
      if (url.length > MAX_IMAGE_BYTES) return 'A picture is too large.'
      pictureBytes += url.length
      parts.push({ type: 'image_url', image_url: { url } })
    } else return 'Only text and picture parts are supported.'
  }
  return { content: parts, pictures: parts.filter((p) => p.type === 'image_url').length, pictureBytes }
}

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
  /** What this capability may run (review 2, S6), written into the descriptor: the approval's route, the
   *  SHA-256 of protocol.json the app read at approval (protocol route) and a fresh run id. */
  binding?: { route: 'protocol' | 'package'; runId: string; approvedAt: number; protocolSha256?: string }
  /** Write the descriptor the agent's runs read (default true). A protocol run gets its capability from the app
   *  directly (protocol-run.ts), so its descriptor is never written: the agent never holds that token (review 5, M3). */
  publish?: boolean
  /** Accept pictures in user messages (relayContent), for a protocol run whose upstream takes them. Default false:
   *  text only. A picture is charged IMAGE_RESERVE_TOKENS instead of its bytes. */
  images?: boolean
}

/** Upstream statuses that mean the provider did not process (or bill) the call: only these are refunded
 *  (review 5, S1). A 500/502/504 can come after the model already ran, so it is never refunded. */
export const NOT_PROCESSED = new Set([400, 401, 403, 404, 413, 422, 429])
export const relayDescriptor = (storage: string, project: string) => join(storage, createHash('sha256').update(project).digest('hex') + '.json')

export async function startModelRelay(options: RelayOptions) {
  const token = randomBytes(32).toString('hex')
  const cap = options.tokenCap ?? 200_000
  const minutes = options.expiryMinutes ?? 30
  if (!options.model || !Number.isSafeInteger(cap) || cap <= 0 || !Number.isSafeInteger(minutes) || minutes <= 0 || minutes > 24 * 60) throw Error('Invalid run limits.')
  let used = 0          // settled calls: their actual tokens (or their reservation when no usage came back)
  let outstanding = 0   // reservations of the calls in flight
  let refunded = 0
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
    let held = 0   // what this request has reserved, for a refund when it never reached the provider
    let open = false   // reserved and not yet settled
    const settle = (amount: number) => { if (!open) return; open = false; outstanding -= held; used += amount }
    try {
      let bytes = 0
      const chunks: Buffer[] = []
      for await (const part of req) {
        bytes += part.length
        if (bytes > (options.images ? MAX_REQUEST_BYTES : MAX_TEXT_BYTES)) return fail(413, 'Run request is too large.')
        chunks.push(part)
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (body.model !== options.model || !Array.isArray(body.messages) || !body.messages.length || body.stream) return fail(400, 'Unsupported model or request.')
      const max = body.max_tokens ?? body.max_completion_tokens ?? DEFAULT_OUTPUT_TOKENS
      if (!Number.isSafeInteger(max) || max < 1 || max > MAX_OUTPUT_TOKENS) return fail(400, 'Output limit must be 1–4096 tokens.')
      // Text bytes / 3 bound the input tokens; extra framing reserve per message; a fixed reserve per picture. Tools,
      // external URLs and provider-specific routing cannot bypass the reservation. The call is settled at the
      // provider's reported usage when it answers (callReservation, actualTokens).
      const contents = body.messages.map((m: any) => relayContent(m, options.images === true))
      const bad = contents.find((c: unknown) => typeof c === 'string')
      if (bad) return fail(400, bad)
      const pictures = contents.reduce((n: number, c: any) => n + c.pictures, 0)
      const pictureBytes = contents.reduce((n: number, c: any) => n + c.pictureBytes, 0)
      if (pictures > MAX_IMAGES) return fail(413, 'Too many pictures in one request.')
      if (bytes - pictureBytes > MAX_TEXT_BYTES) return fail(413, 'Run request is too large.')
      const charge = callReservation(bytes - pictureBytes, body.messages.length, pictures, max)
      if (!admits({ used, outstanding, charge, cap })) return fail(402, 'Run token cap reached.')
      outstanding += charge; held = charge; open = true // synchronous: concurrent requests cannot oversubscribe; refunded only when the provider rejects the call
      await logUsage({ event: 'reserved', model: options.model, reserved: charge })
      const outgoing = { model: options.model, messages: body.messages.map((m: any, i: number) => ({ role: m.role, content: contents[i].content })), max_tokens: max,
        ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
        ...(Number.isSafeInteger(body.seed) ? { seed: body.seed } : {}) }
      const upstream = await fetch(options.upstream.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST', redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${options.key}`, ...(options.bypass ? { 'x-vercel-protection-bypass': options.bypass } : {}) },
        body: JSON.stringify(outgoing),
      })
      const requestId = upstream.headers.get('x-humanstudy-request-id') ?? upstream.headers.get('x-request-id') ?? upstream.headers.get('request-id')
      if (semanticId(requestId)) res.setHeader('x-request-id', requestId)
      if (!upstream.ok) {
        // Refund only a call the provider did not process (review 4, S5; review 5, S1), and never more in total than
        // the cap itself: a rejected call costs nothing, but a 5xx may come after the model ran and billed.
        if (NOT_PROCESSED.has(upstream.status) && refunded + charge <= cap) {
          settle(0); refunded += charge
          await logUsage({ event: 'refunded', model: options.model, reserved: -charge, upstream_status: upstream.status })
        } else { settle(charge); await logUsage({ event: 'failed', model: options.model, reserved: charge, upstream_status: upstream.status }) }
        return fail(502, 'Model provider rejected the request.')
      }
      const reply = await upstream.json() as any
      if (!semanticId(requestId) && semanticId(reply.id)) res.setHeader('x-request-id', reply.id)
      // Return only completion text and usage; upstream diagnostic fields cannot expose credentials.
      const choices = Array.isArray(reply.choices) ? reply.choices.map((c: any, index: number) => ({ index, message: { role: 'assistant', content: typeof c.message?.content === 'string' ? c.message.content : '' }, finish_reason: c.finish_reason })) : []
      const usage = Object.fromEntries(['prompt_tokens', 'completion_tokens', 'total_tokens'].map(k => [k, Number.isSafeInteger(reply.usage?.[k]) && reply.usage[k] >= 0 ? reply.usage[k] : 0]))
      const finish = choices.map((c: any) => typeof c.finish_reason === 'string' ? c.finish_reason.slice(0, 32) : null)
      // Settle at what the provider reports: the unused rest of the reservation is released, and a call that used more
      // than it reserved counts its actual tokens (later calls are refused once the cap is reached). Without usage
      // the reservation stands.
      const actual = actualTokens(reply.usage)
      const settled = actual ?? charge
      settle(settled)
      await logUsage({ event: 'completed', model: options.model, reserved: charge, settled, settledFrom: actual === null ? 'reservation' : 'usage', usage, finish_reason: finish[0] ?? null, truncated: finish.includes('length') })
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices, usage, model: options.model }))
    } catch (error) {
      // A connection refused or a name that does not resolve never reached the provider: refund it too.
      const cause = (error as { cause?: { code?: string; errors?: { code?: string }[] } })?.cause
      const code = cause?.code ?? cause?.errors?.find((e) => e?.code)?.code
      if (open && (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') && refunded + held <= cap) {
        settle(0); refunded += held
        await logUsage({ event: 'refunded', model: options.model, reserved: -held, upstream_error: code }).catch(() => undefined)
      }
      if (!res.headersSent) fail(502, 'Run model request failed.')
    }
    finally { settle(held); requests.delete(controller) }   // anything still open (an abort, an error after the call) counts in full
  })
  server.requestTimeout = 30_000
  server.headersTimeout = 10_000
  server.maxConnections = 16
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('Run relay unavailable.')
  // expiresAt (ms since epoch) lets the launcher give the run script exactly the capability's remaining lifetime.
  const config = { baseURL: `http://127.0.0.1:${address.port}/v1`, token, model: options.model, tokenCap: cap, expiresAt: Date.now() + minutes * 60_000,
    ...(options.binding ? { route: options.binding.route, runId: options.binding.runId, approvedAt: options.binding.approvedAt, ...(options.binding.protocolSha256 ? { protocolSha256: options.binding.protocolSha256 } : {}) } : {}) }
  try {
    await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
    if (options.publish !== false) await writeFile(path, JSON.stringify(config), { mode: 0o600, flag: 'wx' })
  }
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
