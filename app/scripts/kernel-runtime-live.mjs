// Live check that a real kernel's bash tool resolves python / pdftotext into the research runtime.
//   HUMANSTUDY_KERNEL_BIN=<opencode> HUMANSTUDY_RUNTIME_BIN=<runtime>/bin \
//   HUMANSTUDY_DESKTOP_KEY=... HUMANSTUDY_HOSTED_BASEURL=... node scripts/kernel-runtime-live.mjs
import { build } from 'esbuild'
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = mkdtempSync(join(tmpdir(), 'kernel-rt-'))
await build({ entryPoints: [join(here, '../src/main/kernel/index.ts')], bundle: true, platform: 'node', format: 'esm', target: 'node20', outfile: join(out, 'k.mjs'), logLevel: 'error' })
const k = await import(pathToFileURL(join(out, 'k.mjs')).href)
if (process.env.LIVE_PDF && existsSync(process.env.LIVE_PDF)) copyFileSync(process.env.LIVE_PDF, join(out, 'paper.pdf'))
const kernel = new k.OpencodeKernel({ binary: process.env.HUMANSTUDY_KERNEL_BIN, home: join(out, 'khome'), permission: 'ask' })
const id = await kernel.startSession(out)
const done = new Promise((resolve) => {
  kernel.onEvent((e) => {
    if (e.sessionId !== id) return
    if (e.type === 'permission' && !e.permission.resolved) kernel.reply(id, e.permission.id, 'once').catch(() => {})
    if (e.type === 'tool' && e.text === 'completed') console.log('TOOL', e.tool, '\n' + String(e.output ?? '').slice(0, 1500))
    if (e.type === 'error') console.log('ERROR', e.text)
    if (e.type === 'done') resolve()
  })
})
await kernel.send(id, 'Run this exact bash command once and show me its output, nothing else: which python3 python pip pdftotext pdfinfo hs-pdf; python3 -c "import sys,os; print(sys.prefix, os.environ.get(\'PYTHONNOUSERSITE\'), os.environ.get(\'MPLBACKEND\'))"; pdfinfo paper.pdf 2>&1 | head -2')
await Promise.race([done, new Promise((r) => setTimeout(r, 150_000))])
await kernel.dispose()
rmSync(out, { recursive: true, force: true })
