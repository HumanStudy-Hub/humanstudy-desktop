import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

test('automatic hosted Builds use the account model list and retain allowed resumed selections', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hosted-build-model-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const outfile = join(root, 'fixture.mjs')
  await build({
    stdin: {
      contents: "export { OpencodeKernel } from './opencode.ts'; export { startRequestTransport } from './request-transport.ts'",
      resolveDir: fileURLToPath(new URL('.', import.meta.url)), loader: 'ts',
    },
    bundle: true, platform: 'node', format: 'esm', outfile,
  })
  const { OpencodeKernel, startRequestTransport } = await import(pathToFileURL(outfile))
  const haiku = 'anthropic/claude-haiku-5.5', sonnet = 'anthropic/claude-sonnet-5.5'
  let quota = [haiku]
  let listStatus = 200
  let holdLookup
  const lookups = []
  const fixture = createServer((req, res) => {
    if (req.url === '/session/resumed') return res.writeHead(200).end('{}')
    lookups.push({ method: req.method, url: req.url, auth: req.headers.authorization })
    if (holdLookup) return holdLookup()
    res.writeHead(listStatus, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: quota.map(id => ({ id })) }))
  })
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve))
  t.after(() => { fixture.closeAllConnections(); fixture.close() })
  const base = `http://127.0.0.1:${fixture.address().port}`
  const transport = await startRequestTransport({ project: root, upstream: base + '/v1', key: 'offline-hosted-fixture' })
  t.after(() => transport.close())
  const kernel = new OpencodeKernel({ binary: '/bin/true', provider: 'humanstudy', model: haiku })
  t.after(() => kernel.dispose())
  kernel.serverFor = async () => ({ dir: root, base, transport, exited: false })
  const prompts = []
  let nextId = 0
  kernel.request = async (_server, method, path, body) => {
    if (method === 'POST' && path === '/session') return Response.json({ id: 'fresh-' + ++nextId })
    if (path === '/provider') return Response.json({ connected: ['humanstudy'], all: [{ id: 'humanstudy', models: { [haiku]: {}, [sonnet]: {} } }] })
    if (path === '/session/resumed/message' || path === '/question') return Response.json([])
    if (path.endsWith('/abort')) return Response.json(true)
    assert.match(path, /\/prompt_async$/)
    prompts.push(body)
    return Response.json(true)
  }
  const sendBuild = sid => kernel.send(sid, 'Build the paper.', { purpose: 'build' })
  await sendBuild(await kernel.startSession(root))
  assert.equal(prompts.at(-1).model.modelID, haiku, 'a Haiku-only quota can start an automatic Build')
  quota = [haiku, sonnet]
  await sendBuild(await kernel.startSession(root))
  assert.equal(prompts.at(-1).model.modelID, sonnet, 'Sonnet remains preferred when the account can use it')

  assert.equal(await kernel.resumeSession(root, 'resumed'), 'resumed')
  await kernel.native('resumed', { operation: 'select', input: { model: { providerID: 'humanstudy', modelID: haiku } } })
  await sendBuild('resumed')
  assert.equal(prompts.at(-1).model.modelID, haiku, 'the restored explicit choice takes precedence')
  quota = [sonnet]
  await assert.rejects(sendBuild('resumed'), /cannot use the selected hosted model/)
  quota = []
  await assert.rejects(sendBuild(await kernel.startSession(root)), /No hosted Build model is available/)
  listStatus = 503
  await assert.rejects(sendBuild(await kernel.startSession(root)), /Could not check hosted models/)
  assert.equal(prompts.length, 3, 'denied and unavailable lookups never submit a model prompt')
  assert.equal(lookups.length, 6)
  assert.ok(lookups.every(lookup => lookup.method === 'GET' && lookup.url === '/v1/models' && lookup.auth === 'Bearer offline-hosted-fixture'))

  await kernel.send(await kernel.startSession(root), 'Discuss this paper.')
  assert.equal(prompts.at(-1).model.modelID, haiku)
  assert.equal(lookups.length, 6, 'ordinary chat does not make a Build availability request')

  const lookupReached = new Promise(resolve => { holdLookup = resolve })
  const stopped = await kernel.startSession(root)
  const rejected = assert.rejects(sendBuild(stopped), /The Build was stopped/)
  await lookupReached
  await assert.rejects(kernel.native(stopped, { operation: 'shell', input: { command: 'echo fixture' } }), /already checking available models/)
  await kernel.abort(stopped)
  await rejected
  assert.equal(prompts.length, 4, 'a Stop during account lookup never starts inference')
})
