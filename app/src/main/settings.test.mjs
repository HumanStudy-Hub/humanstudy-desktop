import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const { outputFiles: [bundle] } = await build({
  stdin: {
    contents: `export * from './settings'; export { OpencodeKernel } from './kernel/opencode';`,
    resolveDir: here,
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  plugins: [{
    name: 'electron-settings-fixture',
    setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
      builder.onLoad({ filter: /^electron$/, namespace: 'fixture' }, () => ({
        contents: `
          import { dirname } from 'node:path';
          import { fileURLToPath } from 'node:url';
          export const app = { getPath: () => dirname(fileURLToPath(import.meta.url)) };
          export const nativeTheme = {};
        `,
      }))
    },
  }],
})

async function loadSettings(t, startupPermission) {
  const dir = mkdtempSync(join(tmpdir(), 'humanstudy-settings-'))
  const previousEnv = { ...process.env }
  t.after(() => {
    for (const name of ['HUMANSTUDY_PERMISSION', 'HUMANSTUDY_MODEL']) {
      if (previousEnv[name] === undefined) delete process.env[name]
      else process.env[name] = previousEnv[name]
    }
    rmSync(dir, { recursive: true, force: true })
  })
  if (startupPermission === undefined) delete process.env.HUMANSTUDY_PERMISSION
  else process.env.HUMANSTUDY_PERMISSION = startupPermission

  const file = join(dir, 'settings.json')
  writeFileSync(file, JSON.stringify({ permission: 'ask', theme: 'dark', projectsRoot: join(dir, 'projects') }))
  const module = join(dir, 'settings.mjs')
  writeFileSync(module, bundle.contents)
  return { ...await import(pathToFileURL(module).href), readSaved: () => JSON.parse(readFileSync(file, 'utf8')) }
}

function permissionFixture(t, OpencodeKernel, dir) {
  const kernel = new OpencodeKernel({ binary: '/bin/true' })
  t.after(() => kernel.dispose())
  kernel.register('session', { dir, exited: false })
  kernel.sessions.get('session').inFlight = true
  const events = []
  const replies = []
  kernel.onEvent(event => events.push(event))
  kernel.replyTo = async (_server, _session, id, reply) => { replies.push([id, reply]) }
  const ask = (id, filepath) => kernel.handle({
    type: 'permission.asked',
    properties: { sessionID: 'session', id, permission: 'edit', patterns: [filepath], metadata: { filepath } },
  })
  return { kernel, events, replies, ask }
}

test('legacy ask settings use project mode immediately and migrate on the next save', async (t) => {
  const { applySettings, getSettings, setSettings, OpencodeKernel, readSaved } = await loadSettings(t)
  assert.equal(getSettings().permission, 'project')
  assert.equal(getSettings().theme, 'dark')
  assert.equal(readSaved().permission, 'ask')

  process.env.HUMANSTUDY_PERMISSION = 'ask' // A change after module load is not a launch override.
  applySettings()
  assert.equal(process.env.HUMANSTUDY_PERMISSION, 'project')
  const root = getSettings().projectsRoot
  const { kernel, events, replies, ask } = permissionFixture(t, OpencodeKernel, root)
  process.env.HUMANSTUDY_PERMISSION = 'ask' // A running kernel retains its construction mode.
  ask('inside', join(root, 'note.txt'))
  ask('outside', join(dirname(root), 'note.txt'))
  await setImmediate()
  assert.deepEqual(replies, [['inside', 'once'], ['outside', 'reject']])
  assert.deepEqual(events.map(({ permission: { automatic, resolved } }) => [automatic, resolved]), [[true, 'once'], [true, 'reject']])
  assert.deepEqual(kernel.permissions('session'), [])
  assert.equal(readSaved().permission, 'ask')

  assert.equal(setSettings({ notifications: false }).permission, 'project')
  assert.equal(readSaved().permission, 'project')
  assert.equal(setSettings({ permission: 'ask' }).permission, 'project')
  assert.equal(readSaved().permission, 'project')
})

test('a startup ask override survives applying and saving project settings', async (t) => {
  const { applySettings, getSettings, setSettings, OpencodeKernel, readSaved } = await loadSettings(t, 'ask')
  assert.equal(getSettings().permission, 'project')
  delete process.env.HUMANSTUDY_PERMISSION
  applySettings()

  assert.equal(process.env.HUMANSTUDY_PERMISSION, 'ask')
  setSettings({ notifications: false })
  assert.equal(readSaved().permission, 'project')
  assert.equal(process.env.HUMANSTUDY_PERMISSION, 'ask')

  const root = getSettings().projectsRoot
  const { kernel, events, replies, ask } = permissionFixture(t, OpencodeKernel, root)
  delete process.env.HUMANSTUDY_PERMISSION
  ask('inside', join(root, 'note.txt'))
  assert.equal(events.length, 1)
  assert.equal(events[0].permission.resolved, undefined)
  assert.deepEqual(kernel.permissions('session').map(({ id }) => id), ['inside'])
  assert.deepEqual(replies, [])
})

// Three resends after the first try: up to three failures still continue the turn without anyone noticing.
for (const [failures, name] of [
  [1, 'project mode resolves an automatic approval after retrying'],
  [3, 'project mode keeps resending an automatic approval and the turn continues'],
  [4, 'project mode stops the turn without a prompt only when every resend fails'],
]) {
  test(name, { timeout: 5000 }, async (t) => {
    const { getSettings, OpencodeKernel } = await loadSettings(t)
    const root = getSettings().projectsRoot
    const { kernel, events, replies, ask } = permissionFixture(t, OpencodeKernel, root)
    kernel.autoReplyRetryMs = [5, 5, 5]
    const delivered = failures <= kernel.autoReplyRetryMs.length
    kernel.replyTo = async (_server, _session, id, reply) => {
      replies.push([id, reply])
      if (replies.length <= failures) throw new Error('Permission reply unavailable')
    }
    const requests = []
    kernel.request = async (_server, method, path) => {
      requests.push([method, path])
      return new Response(path === '/question' ? '[]' : 'true')
    }
    const finished = new Promise(resolve => {
      const off = kernel.onEvent(event => {
        if (delivered ? event.permission?.resolved === 'once' : event.type === 'done') {
          off()
          resolve()
        }
      })
    })

    ask('inside', join(root, 'note.txt'))
    await setImmediate()
    assert.deepEqual(replies, [['inside', 'once']])
    assert.deepEqual(kernel.permissions('session'), [])
    await finished
    assert.deepEqual(kernel.permissions('session'), [])
    const session = kernel.sessions.get('session')
    assert.equal(session.pendingPermissions.size, 0)
    assert.ok(!events.some(event => event.type === 'permission' && !event.permission.resolved))

    if (delivered) {
      assert.deepEqual(replies, Array(failures + 1).fill(['inside', 'once']))
      assert.deepEqual(requests, [])
      assert.deepEqual(events.map(event => event.type), ['permission'])
      assert.equal(events[0].permission.automatic, true)
    } else {
      assert.deepEqual(replies, [...Array(failures).fill(['inside', 'once']), ['inside', 'reject']])
      assert.deepEqual(requests, [['POST', '/session/session/abort'], ['GET', '/question']])
      assert.deepEqual(events.map(event => event.type), ['error', 'done'])
      assert.match(events[0].text, /automatic permission reply could not be delivered.*Send your message again/)
      assert.equal(events[0].sessionId, 'session')
      assert.equal(session.inFlight, false)

      session.inFlight = true // Simulate an old permission snapshot arriving during a new turn.
      ask('inside', join(root, 'note.txt'))
      assert.equal(session.pendingPermissions.size, 0)
    }
  })
}
