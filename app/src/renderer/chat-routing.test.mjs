// #16: every chat message reaches the agent unchanged. Only the Simulation tab's Run button starts a
// simulation (with its approval message); no keyword guess reroutes typed text.   node src/renderer/chat-routing.test.mjs
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = mkdtempSync(join(tmpdir(), 'chat-routing-'))
try {
  await build({ entryPoints: [join(here, '../shared/simulation-scope.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(out, 'scope.mjs'), logLevel: 'error' })
  const S = await import(pathToFileURL(join(out, 'scope.mjs')).href)
  // The keyword classifier that used to divert messages is gone; approvals are still recognised.
  assert.equal(S.requestsSimulation, undefined, 'no chat-text simulation classifier')
  assert.equal(S.approvalRequest('[Simulation scope approved]\n{"a":1}\nRun 20 per condition.'), 'Run 20 per condition.')
  for (const edit of [
    'Run the check again and change the Help condition label to "Helpful"',
    'Please start the experiment section over: rewrite the procedure steps',
    'Simulate less: remove the pilot from the study document',
    '帮我修改模拟部分的条件描述',
  ]) assert.equal(S.approvalRequest(edit), null, `an edit is not an approval: ${edit}`)

  const app = readFileSync(join(here, 'App.tsx'), 'utf8')
  assert.ok(!/requestsSimulation|reviewRun|simulationRequest/.test(app), 'App.tsx no longer intercepts chat text')
  const chatSession = /session=\{\{ \.\.\.session, ([^\n]*)\}\}/.exec(app)?.[1] ?? ''
  for (const fn of ['send', 'enqueue', 'interruptAndSend'])
    assert.ok(chatSession.includes(`${fn}: text => sendInWorkspace(text, session.${fn})`), `chat ${fn} goes straight to the agent`)
  const workbench = readFileSync(join(here, 'components/Workbench.tsx'), 'utf8')
  assert.ok(!/simulationRequest/.test(workbench), 'the Simulation tab is not steered by chat text')
  console.log('chat routing: every message reaches the agent')
} finally {
  rmSync(out, { recursive: true, force: true })
}
