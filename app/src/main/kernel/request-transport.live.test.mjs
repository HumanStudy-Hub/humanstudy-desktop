// Real pinned OpenCode + an offline model fixture: no paid inference, no research conclusions.
// HUMANSTUDY_KERNEL_BIN=<binary> HUMANSTUDY_TEST_PAGES=<23-page image directory> node ...
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, readdirSync, mkdirSync, copyFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

if (!process.env.HUMANSTUDY_KERNEL_BIN || !process.env.HUMANSTUDY_TEST_PAGES) { console.log('SKIP: explicit pinned binary and page images required'); process.exit(0) }
const out = realpathSync(mkdtempSync(join(tmpdir(), 'native-payload-')))
const project = join(out, 'project'); mkdirSync(project)
const pages = readdirSync(process.env.HUMANSTUDY_TEST_PAGES).filter(file => /^page-\d+\.png$/.test(file)).sort()
assert.equal(pages.length, 23)
for (const file of pages) copyFileSync(join(process.env.HUMANSTUDY_TEST_PAGES, file), join(project, file))
await build({ entryPoints: [join(dirname(fileURLToPath(import.meta.url)), 'index.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(out, 'kernel.mjs'), logLevel: 'error' })
const { OpencodeKernel } = await import(pathToFileURL(join(out, 'kernel.mjs')))
const requests = []
const upstream = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks); const body = JSON.parse(raw)
  requests.push({ bytes: raw.length, archived: raw.includes(Buffer.from('Full image retained locally:')) })
  if (raw.length > 4_000_000) { res.writeHead(413, { 'content-type': 'application/json' }); res.end('{"error":{"message":"Request too large"}}'); return }
  const results = body.messages?.filter(message => message.role === 'tool') ?? []
  const n = results.length
  const call = body.tools?.length && n <= pages.length
    ? n < pages.length
      ? { name: 'read', arguments: JSON.stringify({ filePath: join(project, pages[n]) }) }
      : { name: 'bash', arguments: JSON.stringify({ command: `printf '%s\\n' '{"fixture":true,"pagesRead":23}' > program.json`, description: 'Save the transport test checkpoint' }) }
    : undefined
  const delta = call ? { tool_calls: [{ index: 0, id: 'call_' + n, type: 'function', function: call }] } : { content: 'Transport fixture completed.' }
  const frame = choices => ({ id: 'fixture_' + requests.length, object: 'chat.completion.chunk', created: 1, model: body.model, choices })
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(`data: ${JSON.stringify(frame([{ index: 0, delta, finish_reason: null }]))}\n\n`)
  res.end(`data: ${JSON.stringify({ ...frame([{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }]), usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\ndata: [DONE]\n\n`)
})
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
process.env.HUMANSTUDY_DESKTOP_KEY = 'offline-fixture-only'
process.env.HUMANSTUDY_HOSTED_BASEURL = `http://127.0.0.1:${upstream.address().port}/v1`
delete process.env.HUMANSTUDY_SERVER_BYPASS
delete process.env.OPENROUTER_API_KEY
const kernel = new OpencodeKernel({ binary: process.env.HUMANSTUDY_KERNEL_BIN, home: join(out, 'home'), provider: 'humanstudy', model: 'transport-fixture', permission: 'project' })
const configContent = kernel.configContent.bind(kernel)
kernel.configContent = transport => {
  assert.ok(transport, 'real desktop transport must be installed')
  assert.match(transport.baseURL, /^http:\/\/127\.0\.0\.1:\d+\/v1$/)
  assert.match(process.env.HUMANSTUDY_HOSTED_BASEURL, /^http:\/\/127\.0\.0\.1:\d+\/v1$/)
  const config = JSON.parse(configContent(transport))
  assert.equal(config.provider.humanstudy.options.baseURL, transport.baseURL)
  assert.equal(config.provider.humanstudy.options.apiKey, transport.token)
  config.provider.humanstudy.npm = '@ai-sdk/openai-compatible'
  config.provider.humanstudy.models = { 'transport-fixture': { name: 'Offline transport fixture', tool_call: true, attachment: true, modalities: { input: ['text', 'image'], output: ['text'] }, limit: { context: 200000, output: 1000 } } }
  assert.equal(config.model, 'humanstudy/transport-fixture')
  assert.equal(config.small_model, 'humanstudy/transport-fixture')
  return JSON.stringify(config)
}
const events = []
try {
  const sid = await kernel.startSession(project)
  let timer
  const done = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Native fixture timed out: ' + JSON.stringify(events.slice(-8)))), 90_000)
    kernel.onEvent(event => { if (event.sessionId !== sid) return; events.push(event); if (event.type === 'error') reject(new Error(event.text)); if (event.type === 'done') resolve() })
  })
  try { await kernel.send(sid, 'Read each provided page image, then save the fixture checkpoint.'); await done }
  finally { clearTimeout(timer) }
  assert.deepEqual(JSON.parse(readFileSync(join(project, 'program.json'), 'utf8')), { fixture: true, pagesRead: 23 })
  assert.ok(requests.some(request => request.archived), 'the native chain exercised payload adaptation')
  assert.ok(requests.every(request => request.bytes <= 3_600_000), 'all upstream request bodies fit the gateway limit')
  const history = await kernel.native(sid, { operation: 'history' })
  const nativeBytes = Buffer.byteLength(JSON.stringify(history))
  assert.ok(nativeBytes > 4_500_000, 'full native image history still exists beyond the hosting limit')
  const archive = join(project, '.humanstudy/tmp/request-archive')
  const originals = pages.map(file => readFileSync(join(project, file)))
  for (const file of readdirSync(archive)) assert.ok(originals.some(bytes => bytes.equals(readFileSync(join(archive, file)))), 'archive exactly matches original source bytes')
  console.log(JSON.stringify({ realKernel: true, model: 'offline deterministic fixture', pagesRead: 23, checkpointWritten: true, requests: requests.length, maxRequestBytes: Math.max(...requests.map(request => request.bytes)), nativeHistoryBytes: nativeBytes, archivedImages: readdirSync(archive).length }))
} finally {
  await kernel.dispose(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve))
  rmSync(out, { recursive: true, force: true })
}
