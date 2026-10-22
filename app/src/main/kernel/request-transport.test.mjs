import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = mkdtempSync(join(tmpdir(), 'request-transport-'))
await build({ entryPoints: [join(dirname(fileURLToPath(import.meta.url)), 'request-transport.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(root, 'transport.mjs'), logLevel: 'error' })
const { fitRequest, startRequestTransport, REQUEST_BYTES } = await import(pathToFileURL(join(root, 'transport.mjs')))
const image = bytes => ({ type: 'image_url', image_url: { url: 'data:image/png;base64,' + bytes.toString('base64') } })
const originalImage = Buffer.alloc(2_000_000, 21)
const latestImage = Buffer.alloc(1_000_000, 42)
const raw = JSON.stringify({ model: 'fixture', messages: [{ role: 'user', content: [image(originalImage)] }, { role: 'assistant', tool_calls: [{ id: 'original-call', type: 'function', function: { name: 'read', arguments: '{"filePath":"page.png"}' } }] }, { role: 'tool', tool_call_id: 'original-call', content: [{ type: 'text', text: 'Latest evidence' }, image(latestImage)] }] })
assert.ok(Buffer.byteLength(raw) > 4_000_000)
const fit = fitRequest(raw, root)
assert.ok(Buffer.byteLength(fit.body) < REQUEST_BYTES)
const fitted = JSON.parse(fit.body)
assert.equal(fitted.messages[0].content[0].type, 'text')
assert.deepEqual(fitted.messages[2].content[1], image(latestImage), 'latest visual evidence remains inline')
assert.deepEqual(fitted.messages[1], JSON.parse(raw).messages[1], 'tool call IDs/arguments never change')
const archive = join(root, '.humanstudy/tmp/request-archive')
assert.ok(readFileSync(join(archive, readdirSync(archive)[0])).equals(originalImage), 'archived image bytes are exact')
assert.equal(JSON.parse(raw).messages[0].content[0].type, 'image_url', 'original history was not mutated')
assert.deepEqual(fitRequest('{"untouched":true}', root), { body: '{"untouched":true}', archived: 0 })
const pdfBytes = Buffer.from('%PDF-1.7\n' + 'source'.repeat(650_000) + '\n%%EOF')
const pdf = JSON.stringify({ messages: [{ role: 'user', content: [{ type: 'file', file: { filename: 'paper.pdf', file_data: 'data:application/pdf;base64,' + pdfBytes.toString('base64') } }] }] })
const pdfFit = fitRequest(pdf, root)
assert.match(JSON.parse(pdfFit.body).messages[0].content[0].text, /hs-pdf pages/)
assert.ok(readdirSync(archive).some(file => file.endsWith('.pdf') && readFileSync(join(archive, file)).equals(pdfBytes)), 'entire original PDF retained')

// A UTF-8 body can exceed the limit despite a much smaller JS string length.
const fullText = '原文证据'.repeat(310_000) + '\nFINAL EVIDENCE — NOT TRUNCATED'
const textRaw = JSON.stringify({ messages: [{ role: 'tool', tool_call_id: 'old', content: fullText }, { role: 'tool', tool_call_id: 'new', content: 'Last tool output' }] })
assert.ok(textRaw.length < REQUEST_BYTES && Buffer.byteLength(textRaw) > REQUEST_BYTES)
const textFit = fitRequest(textRaw, root)
assert.ok(readdirSync(archive).some(file => file.endsWith('.txt') && readFileSync(join(archive, file), 'utf8') === fullText))
assert.equal(JSON.parse(textFit.body).messages[1].content, 'Last tool output')
assert.throws(() => fitRequest(JSON.stringify({ messages: [{ role: 'user', content: fullText }] }), root), /page ranges/)

// Reject archive symlinks without writing research data outside the project.
const unsafe = join(root, 'unsafe'), outside = join(root, 'outside')
mkdirSync(unsafe); mkdirSync(outside); symlinkSync(outside, join(unsafe, '.humanstudy'))
assert.throws(() => fitRequest(raw, unsafe), /inside the project/)

const requests = []
let mode = 'stream'
let cancelled
const upstream = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk)
  const body = Buffer.concat(chunks)
  requests.push({ bytes: body.length, body: body.toString(), auth: req.headers.authorization, bypass: req.headers['x-vercel-protection-bypass'] })
  if (mode === 'payload') { res.writeHead(413, { 'x-vercel-error': 'FUNCTION_PAYLOAD_TOO_LARGE' }); res.end('Request Entity Too Large'); return }
  if (mode === 'context') { res.writeHead(413, { 'content-type': 'application/json' }); res.end('{"error":{"code":"context_length_exceeded","message":"maximum context length exceeded"}}'); return }
  if (mode === 'rate') { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '2' }); res.end('{"error":{"message":"rate limited"}}'); return }
  res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: {"delta":"first"}\n\n')
  if (mode === 'hold') { res.on('close', () => cancelled?.()); return }
  res.end('data: [DONE]\n\n')
})
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
const adjustments = []
const transport = await startRequestTransport({ project: root, upstream: `http://127.0.0.1:${upstream.address().port}/v1`, key: 'fixture-upstream-only', bypass: 'fixture-bypass', onAdjust: count => adjustments.push(count) })
const send = (body = raw, auth = transport.token, path = '/chat/completions', signal) => fetch(transport.baseURL + path, { method: 'POST', headers: { authorization: `Bearer ${auth}` }, body, signal })
try {
  assert.equal((await send(raw, 'wrong')).status, 401)
  assert.equal((await send(raw, transport.token, '/unapproved')).status, 404)
  assert.equal(requests.length, 0)
  const response = await send()
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'data: {"delta":"first"}\n\ndata: [DONE]\n\n')
  assert.ok(requests[0].bytes < REQUEST_BYTES)
  assert.equal(requests[0].auth, 'Bearer fixture-upstream-only')
  assert.equal(requests[0].bypass, 'fixture-bypass')
  assert.ok(adjustments.length)
  const beforeUnsafe = requests.length
  assert.equal((await send(JSON.stringify({ messages: [{ role: 'user', content: fullText }] }))).status, 400)
  assert.equal(requests.length, beforeUnsafe, 'unfit requests never reach gateway')
  mode = 'payload'
  // Initially fits, then upstream 413 triggers a single changed request.
  const initial = JSON.stringify({ messages: [{ role: 'user', content: [image(originalImage), { type: 'text', text: 'keep me' }] }] })
  const beforeRetry = requests.length
  const failure = await send(initial)
  assert.equal(failure.status, 400)
  assert.equal((await failure.json()).error.code, 'humanstudy_request_body_too_large')
  assert.equal(requests.length - beforeRetry, 2)
  assert.ok(requests.at(-1).bytes < requests.at(-2).bytes, 'retry changes the payload, not just continue')
  mode = 'context'
  const context = await send('{"messages":[]}')
  assert.equal(context.status, 413, 'real context overflow remains available to native compaction')
  mode = 'rate'
  const limited = await send('{"messages":[]}')
  assert.equal(limited.status, 429)
  assert.equal(limited.headers.get('retry-after'), '2')
  mode = 'hold'
  const controller = new AbortController()
  const closed = new Promise((resolve, reject) => { cancelled = resolve; setTimeout(() => reject(new Error('Upstream did not cancel')), 3000).unref() })
  const held = await send('{"messages":[]}', transport.token, '/chat/completions', controller.signal)
  await held.body.getReader().read()
  controller.abort()
  await closed
  console.log('UTF-8 limits, full evidence archive, latest image, bounded adjusted retry, context/rate errors, streaming and cancellation passed')
} finally {
  transport.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve))
  rmSync(root, { recursive: true, force: true })
}
