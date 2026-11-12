import { build } from 'esbuild'
import electronBin from 'electron'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = mkdtempSync(join(tmpdir(), 'permission-restore-'))
try {
  await build({
    stdin: { resolveDir: here, loader: 'tsx', contents: `
      import { useState } from 'react'
      import { createRoot } from 'react-dom/client'
      import { useSession } from './useSession'
      import { PermissionCard } from './components/Permission'
      const permission = { id: 'permission-A', type: 'bash', title: 'echo fixture' }
      const pending = new Map()
      const listeners = new Set()
      const stopped = []
      const emit = event => listeners.forEach(listener => listener(event))
      window.fixture = { pending, stopped, permission, emit }
      window.humanstudy = {
        threads: {
          list: async dir => [{ id: dir }],
          resume: async dir => ({
            id: dir, kernelSessionId: dir, usage: { input: 0, output: 0, cost: 0 },
            messages: dir === 'A' ? [{ role: 'assistant', parts: [{ kind: 'permission', ...permission }] }] : [],
          }),
          onChanged: () => () => {},
        },
        kernel: {
          permissions: sid => new Promise(resolve => pending.set(sid, resolve)),
          questions: async () => [],
          onEvent: listener => { listeners.add(listener); return () => listeners.delete(listener) },
          reply: async (sid, id, response) => emit({ sessionId: sid, type: 'permission', permission: { id, type: '', resolved: response } }),
          abort: async sid => { stopped.push(sid) },
        },
      }
      function Conversation({ dir }) {
        const session = useSession(dir)
        return <>
          <output>{session.id}</output>
          {session.pendingPermissions.map(part => <PermissionCard key={part.id} part={part} onReply={session.reply} />)}
          {session.busy && <button id="stop" onClick={session.abort}>Stop</button>}
        </>
      }
      function App() {
        const [state, set] = useState({ dir: 'A', key: 0 })
        window.fixture.switchTo = dir => set(s => ({ ...s, dir }))
        window.fixture.remount = () => set(s => ({ ...s, key: s.key + 1 }))
        return <Conversation key={state.key} dir={state.dir} />
      }
      createRoot(document.getElementById('root')).render(<App />)
    ` },
    bundle: true, platform: 'browser', jsx: 'automatic', outfile: join(out, 'fixture.js'),
    define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'error',
  })
  writeFileSync(join(out, 'index.html'), '<div id="root"></div><script src="fixture.js"></script>')
  writeFileSync(join(out, 'runner.cjs'), `
    const { app, BrowserWindow } = require('electron')
    const assert = require('node:assert/strict')
    app.setPath('userData', ${JSON.stringify(join(out, 'userdata'))})
    app.whenReady().then(async () => {
      const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } })
      const js = source => win.webContents.executeJavaScript(source, true)
      const waitFor = async source => {
        for (let i = 0; i < 100; i++) {
          if (await js(source)) return
          await new Promise(resolve => setTimeout(resolve, 20))
        }
        assert.fail(source)
      }
      const hydrate = async (sid, expr) => {
        await waitFor('fixture.pending.has(' + JSON.stringify(sid) + ')')
        await js('fixture.pending.get(' + JSON.stringify(sid) + ')(' + expr + ')')
        await js('fixture.pending.delete(' + JSON.stringify(sid) + ')')
      }
      const card = "document.querySelector('.perm.pending')"
      const stop = "document.querySelector('#stop')"
      try {
        await win.loadFile(${JSON.stringify(join(out, 'index.html'))})
        await hydrate('A', '[fixture.permission]')
        await waitFor(card + ' && ' + stop)
        await js('fixture.remount()')
        await hydrate('A', '[fixture.permission]')
        await waitFor(card + ' && ' + stop)
        await js("document.querySelector('.perm.pending .primary').click()")
        await waitFor('!' + card)
        await js('fixture.remount()')
        await waitFor("fixture.pending.has('A')")
        await js("fixture.emit({ sessionId: 'A', type: 'permission', permission: { ...fixture.permission, resolved: 'once' } })")
        await hydrate('A', '[fixture.permission]')
        await waitFor('!' + card + ' && !' + stop)

        await js('fixture.remount()')
        await waitFor("fixture.pending.has('A')")
        await js("fixture.switchTo('B')")
        await hydrate('B', '[]')
        await hydrate('A', '[fixture.permission]')
        await waitFor("document.querySelector('output').textContent === 'B' && !" + card)
        await js("fixture.switchTo('A')")
        await waitFor("fixture.pending.has('A')")
        await js("fixture.emit({ sessionId: 'A', type: 'permission', permission: fixture.permission })")
        await waitFor(card + ' && ' + stop)
        await js(stop + '.click()')
        await hydrate('A', '[fixture.permission]')
        await waitFor("fixture.stopped.join(',') === 'A' && !" + card + ' && !' + stop)
        await js("fixture.emit({ sessionId: 'A', type: 'done' })")
        console.log('Permission card restores on remount and stays cleared after reply, project switch or Stop')
      } catch (error) {
        console.error(error)
        process.exitCode = 1
      } finally {
        win.destroy()
        app.exit(process.exitCode || 0)
      }
    })
  `)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const code = await new Promise((resolve, reject) => {
    const child = spawn(electronBin, [join(out, 'runner.cjs')], { stdio: 'inherit', env })
    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error('Permission renderer test timed out'))
    }, 30000)
    child.on('error', reject)
    child.on('exit', code => { clearTimeout(timeout); resolve(code) })
  })
  if (code !== 0) process.exitCode = 1
} finally {
  rmSync(out, { recursive: true, force: true })
}
