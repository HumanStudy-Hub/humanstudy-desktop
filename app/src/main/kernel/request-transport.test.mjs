import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = mkdtempSync(join(tmpdir(), 'request-transport-'))
await build({ entryPoints: [join(dirname(fileURLToPath(import.meta.url)), 'request-transport.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(root, 'transport.mjs'), logLevel: 'error' })
const { fitRequest, startRequestTransport, REQUEST_BYTES, REQUEST_TARGET_BYTES } = await import(pathToFileURL(join(root, 'transport.mjs')))
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

// Stable cut: 30 turns, each reading one more ~240 KB page image (the size of a rendered paper
// page). The archived prefix may only move on the turn whose history crosses the trigger; between
// those turns every earlier message must be byte-identical so the provider prompt cache survives.
{
  const stable = join(root, 'stable'); mkdirSync(stable)
  const pages = Array.from({ length: 30 }, () => randomBytes(180_000))
  const history = [{ role: 'system', content: 'You convert papers.' }, { role: 'user', content: 'Read every page.' }]
  const turns = []
  for (let turn = 0; turn < pages.length; turn++) {
    history.push({ role: 'assistant', content: null, tool_calls: [{ id: 'call_' + turn, type: 'function', function: { name: 'read', arguments: JSON.stringify({ filePath: `page-${turn}.png` }) } }] })
    history.push({ role: 'tool', tool_call_id: 'call_' + turn, content: `Image read successfully: page ${turn}` })
    history.push({ role: 'user', content: [{ type: 'text', text: 'Attached image(s) from tool result:' }, image(pages[turn])] })
    // OpenCode marks the newest messages for prompt caching, so the tail differs between turns.
    const messages = history.map((message, index) => index >= history.length - 2 ? { ...message, cache_control: { type: 'ephemeral' } } : message)
    const raw = JSON.stringify({ model: 'fixture', messages, tools: [{ type: 'function', function: { name: 'read', parameters: {} } }] })
    const out = JSON.parse(fitRequest(raw, stable).body)
    const inline = out.messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.type === 'image_url' || /image was removed/.test(part.text ?? '')) : [])
    const cut = inline.findIndex(part => part.type === 'image_url')
    assert.ok(cut >= 0, 'newest page stays inline')
    assert.ok(inline.slice(cut).every(part => part.type === 'image_url'), 'only the oldest pages are archived')
    turns.push({ raw, cut, bytes: Buffer.byteLength(JSON.stringify(out)), messages: out.messages.map(({ cache_control, ...message }) => JSON.stringify(message)) })
    assert.ok(turns.at(-1).bytes <= REQUEST_BYTES)
    assert.equal(fitRequest(raw, stable).body, JSON.stringify(out), 'same history gives the same request')
  }
  const moves = []
  for (let turn = 1; turn < turns.length; turn++) {
    const [before, now] = [turns[turn - 1], turns[turn]]
    assert.ok(now.cut >= before.cut, 'the cut never moves back')
    if (now.cut === before.cut) {
      assert.deepEqual(now.messages.slice(0, before.messages.length), before.messages, `turn ${turn} appends without changing the prefix`)
    } else {
      moves.push(turn)
      assert.ok(Buffer.byteLength(now.raw) > REQUEST_BYTES, 'the cut only moves once the trigger is crossed')
      assert.ok(now.bytes <= REQUEST_TARGET_BYTES + 250_000, `turn ${turn} drops back to the target`)
    }
  }
  // ~7.3 MB of pages: crossing 3.6 MB once and then every ~1.6 MB, not on every one of the ~16 turns past the limit.
  assert.ok(moves.length >= 2 && moves.length <= 4, `cut moved on turns ${moves}`)
  for (let turn = 1; turn < moves.length; turn++) assert.ok(moves[turn] - moves[turn - 1] >= 6, 'at least ~1.6 MB of new pages between cuts')
  const archived = readdirSync(join(stable, '.humanstudy/tmp/request-archive'))
  assert.equal(archived.length, turns.at(-1).cut, 'one content-addressed file per archived page, never rewritten')
  assert.ok(turns.at(-1).messages.join('').includes('.humanstudy/tmp/request-archive/'), 'placeholder uses a project-relative forward-slash path')
  assert.ok(!turns.at(-1).messages.join('').includes(stable), 'placeholder never embeds the absolute local path')
  console.log(`stable cut: moved on turns ${moves.join(', ')} of ${turns.length}; max body ${Math.max(...turns.map(t => t.bytes))} bytes`)
}

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
