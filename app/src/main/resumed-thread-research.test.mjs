import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

test('a resumed native thread captures only new assistant and tool events under its action', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'hs-resumed-research-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const here = fileURLToPath(new URL('.', import.meta.url))
  const owner = '11111111-1111-4111-8111-111111111111'
  const project = join(temp, 'study')
  const projectId = '22222222-2222-4222-8222-222222222222'
  await mkdir(join(project, '.humanstudy'), { recursive: true })
  await writeFile(join(project, '.humanstudy', 'project.json'), JSON.stringify({ id: projectId }))
  const fixture = 'research-fixture@example.test'
  const outfile = join(temp, 'telemetry.mjs')
  await build({
    stdin: { contents: "export * from './telemetry.ts'; export {accountHash} from './telemetry-core.ts'", resolveDir: here, loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', outfile, plugins: [{
      name: 'offline-electron-and-account',
      setup(builder) {
        builder.onResolve({ filter: /^(electron|\.\/account)$/ }, ({ path }) => ({ path, namespace: 'fixture' }))
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'electron'
          ? `export const app={getPath:()=>${JSON.stringify(temp)},getVersion:()=>'0.0.0-test'}; export const BrowserWindow={},dialog={},ipcMain={};`
          : `export const getAccount=()=>({status:()=>({email:${JSON.stringify(fixture)}}),researchOwner:()=>${JSON.stringify(owner)},restAuth:async()=>null});` }))
      },
    }],
  })
  const telemetry = await import(pathToFileURL(outfile))
  await writeFile(join(temp, 'telemetry.json'), JSON.stringify({
    consent: { version: 3, usage: true, content: true, decidedAt: new Date().toISOString(), acct: telemetry.accountHash(fixture) },
  }))
  const main = await readFile(join(here, 'index.ts'), 'utf8')
  assert.match(main, /resume: async \(dir, sid\) => \{[\s\S]*?if \(alive\) \{[^}]*telemetry\.bindSession\(alive, dir\)/)

  const sid = 'ses_restored'
  const operation = { id: '33333333-3333-4333-8333-333333333333', target: 'composer.send', via: 'pointer' }
  telemetry.onKernelEvent({ sessionId: sid, type: 'text', text: 'historical response' })
  telemetry.bindSession(sid, project)
  telemetry.bindSession(sid, project)
  telemetry.trackTurnStart(sid, 'Check this study', operation)
  telemetry.onKernelEvent({ sessionId: sid, type: 'tool', tool: 'bash', toolCallId: 'call_restored', text: 'running', input: { command: 'echo fixture' } })
  telemetry.onKernelEvent({ sessionId: sid, type: 'tool', tool: 'bash', toolCallId: 'call_restored', text: 'completed', output: 'fixture' })
  telemetry.onKernelEvent({ sessionId: sid, type: 'text', messageId: 'msg_restored', text: 'New response' })
  telemetry.onKernelEvent({ sessionId: sid, type: 'done' })
  await telemetry.settleResearch()

  const queue = join(temp, 'research-v1', owner, 'events')
  const rows = await Promise.all((await readdir(queue)).map(async file => JSON.parse(await readFile(join(queue, file), 'utf8'))))
  const turn = rows.filter(row => row.thread_id === sid)
  const row = type => turn.find(event => event.event_type === type)
  assert.equal(turn.filter(event => event.event_type === 'action.invoke').length, 1)
  assert.equal(row('action.invoke').id, operation.id)
  assert.equal(row('tool.end').caused_by, row('tool.start').id)
  assert.equal(row('tool.end').tool_call_id, 'call_restored')
  assert.equal(row('agent.turn_end').metadata.status, 'complete')
  assert.ok(turn.some(event => event.event_type === 'conversation.message' && event.metadata.role === 'assistant' && event.metadata.text === 'New response'))
  assert.ok(turn.every(event => event.project_id === projectId && event.action_id === operation.id))
  assert.ok(!rows.some(event => event.metadata.text === 'historical response' || event.event_type === 'kernel.session_start'))
})
