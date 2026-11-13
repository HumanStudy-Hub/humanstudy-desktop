import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

const chrome = [
  process.env.HUMANSTUDY_TEST_CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find(path => path && existsSync(path))

test('the online Home only forks the selected revision after an explicit click', { skip: !chrome && 'Chrome unavailable' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hs-paper-handoff-'))
  try {
    await build({
      stdin: {
        contents: `
          import { createRoot } from 'react-dom/client'
          import { Home } from './components/Home'
          import { assertPaperRevision } from '../shared/paper-handoff'

          const paper = 'paper_' + 'a'.repeat(24)
          const revision = 'b'.repeat(64)
          const staleRevision = 'c'.repeat(64)
          const entry = { id: paper, title: 'Paper handoff fixture', currentRevision: revision,
            authors: [], contributors: [], year: null, description: 'Fixture.', files: [], activity: [] }
          const requests = []
          const forks = []
          const opened = []
          let detailFailure = ''
          let finishLoading
          let releaseFork
          window.humanstudy = {
            app: { info: async () => ({ version: 'test' }) },
            projects: { list: async () => [] },
            community: {
              studies: async () => [entry],
              study: async (id, expectedRevision) => {
                requests.push([id, expectedRevision])
                if (detailFailure === 'wait') await new Promise(resolve => { finishLoading = resolve })
                if (detailFailure) throw Error(detailFailure)
                assertPaperRevision(entry.currentRevision, expectedRevision)
                return entry
              },
              fork: async (id, expectedRevision) => {
                forks.push([id, expectedRevision])
                assertPaperRevision(entry.currentRevision, expectedRevision)
                return new Promise(resolve => { releaseFork = () => resolve('/projects/copied-paper') })
              },
            },
          }

          function check(condition, message) {
            if (!condition) throw Error(message)
          }
          async function until(predicate, message) {
            for (let attempt = 0; attempt < 100; attempt++) {
              const value = predicate()
              if (value) return value
              await new Promise(resolve => setTimeout(resolve, 10))
            }
            throw Error(message)
          }
          function button(text) {
            return [...document.querySelectorAll('button')].find(button => button.textContent.trim() === text)
          }
          function mount(targetRevision) {
            if (targetRevision) {
              history.replaceState(null, '', location.pathname + '?' + new URLSearchParams({
                paper, revision: targetRevision, intent: 'run', other: 'preserved',
              }))
            }
            const root = createRoot(document.getElementById('root'))
            root.render(<Home onOpen={dir => opened.push(dir)} onSettings={() => {}}
              onAccount={() => {}} account={null} kernel={{status: null, retry() {}}} />)
            return root
          }

          async function run() {
            if (sessionStorage.getItem('handoff-complete')) {
              const root = mount()
              await until(() => document.querySelector('.home-main'), 'Home did not reopen after refresh')
              check(!button('Open in my projects') && !requests.length && !forks.length && !opened.length,
                'Refresh retried the completed handoff')
              root.unmount()
              return 'HANDOFF_OK'
            }

            let root = mount(staleRevision)
            await until(() => document.body.textContent.includes('different published version'), 'Stale revision error absent')
            check(button('Open in my projects').disabled, 'Stale copy is enabled')
            check(requests.length === 1 && requests[0][0] === paper && requests[0][1] === staleRevision, 'Stale detail request lost the revision')
            check(forks.length === 0, 'Stale handoff attempted a fork')
            root.unmount()

            detailFailure = 'wait'
            root = mount(revision)
            await until(() => finishLoading && document.body.textContent.includes('Loading study…'), 'Loading status absent')
            check(!document.body.textContent.includes('A Human Study Program is unavailable') && !document.body.textContent.includes('No description'),
              'Loading study shows an unavailable program or missing description')
            detailFailure = 'Temporary catalog error'
            finishLoading()
            const retry = await until(() => button('Try again'), 'Retry action absent')
            check(button('Open in my projects').disabled, 'Unverified copy is enabled')
            detailFailure = ''
            retry.click()
            const copy = await until(() => {
              const action = button('Open in my projects')
              return action && !action.disabled && action
            }, 'Verified copy action absent')
            check(requests.length === 3 && requests.slice(1).every(([id, rev]) => id === paper && rev === revision),
              'Detail and retry must both use the exact revision')
            check(forks.length === 0 && opened.length === 0, 'Page load or retry created a project')

            copy.click()
            const copying = await until(() => button('Copying…'), 'Copy-in-progress state absent')
            check(copying.disabled, 'Copy-in-progress action is enabled')
            copying.click()
            check(forks.length === 1 && forks[0][0] === paper && forks[0][1] === revision, 'Fork did not receive one exact revision')
            releaseFork()
            await until(() => opened.length === 1, 'Copied project was not opened')
            check(opened[0] === '/projects/copied-paper', 'Wrong project opened')
            const params = new URLSearchParams(location.search)
            check(!params.has('paper') && !params.has('revision') && !params.has('intent') && params.get('other') === 'preserved',
              'Completed handoff was not removed from the address')

            await until(() => !button('Open in my projects'), 'Completed study did not close')
            check(forks.length === 1 && opened.length === 1 && requests.length === 3, 'Handoff issued a duplicate request')
            sessionStorage.setItem('handoff-complete', 'true')
            location.reload()
          }

          run().then(result => {
            if (result) return fetch('/result', { method: 'POST', body: result })
          }, error => fetch('/result', { method: 'POST', body: error.stack }))
        `,
        resolveDir: fileURLToPath(new URL('.', import.meta.url)),
        loader: 'tsx',
      },
      bundle: true, platform: 'browser', jsx: 'automatic', logLevel: 'error',
      loader: { '.css': 'empty' }, outfile: join(dir, 'handoff.js'),
    })
    const script = await readFile(join(dir, 'handoff.js'))
    let reportResult
    let failTest
    const result = new Promise((resolve, reject) => {
      reportResult = resolve
      failTest = reject
    })
    const server = createServer((request, response) => {
      if (request.method === 'POST' && request.url === '/result') {
        let message = ''
        request.setEncoding('utf8')
        request.on('data', chunk => { message += chunk })
        request.on('end', () => {
          response.writeHead(204).end()
          reportResult(message)
        })
      } else if (request.url === '/handoff.js') {
        response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(script)
      } else {
        response.writeHead(200, { 'Content-Type': 'text/html' }).end(
          '<!doctype html><title>HANDOFF_PENDING</title><div id="root"></div><script>window.__HS_WEB__ = true; window.onerror = (msg) => fetch("/result", {method: "POST", body: String(msg)}); window.onunhandledrejection = (e) => fetch("/result", {method: "POST", body: String(e.reason)})</script><script src="/handoff.js"></script>')
      }
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const browser = spawn(chrome, [
      '--headless', '--disable-gpu', '--no-first-run', '--disable-dev-shm-usage', '--disable-background-networking',
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      `--user-data-dir=${join(dir, 'chrome')}`, `http://127.0.0.1:${server.address().port}/`,
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
    let diagnostics = ''
    browser.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-2000) })
    const timeout = setTimeout(() => failTest(new Error('Browser did not complete the handoff test: ' + diagnostics)), 60_000)
    browser.on('error', failTest)
    browser.on('exit', code => failTest(new Error(`Chrome exited early (${code})`)))
    try {
      assert.equal(await result, 'HANDOFF_OK')
    } finally {
      clearTimeout(timeout)
      browser.kill('SIGKILL')
      browser.stderr.destroy()
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
