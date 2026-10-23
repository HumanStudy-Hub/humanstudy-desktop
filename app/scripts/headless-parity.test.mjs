// The headless OpenCode worker must run the desktop's own kernel, collector and completion code:
//   node app/scripts/headless-parity.test.mjs
// Optional: HUMANSTUDY_WEB_CONTRACT=<web checkout>/lib/research-data/contract.ts also checks the
// vendored contract against the canonical web copy.
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../..')
const worker = readFileSync(join(here, 'opencode-assets.mjs'), 'utf8')
const SHARED = ['research-collector.ts', 'research-agent.ts', 'research-contract.ts']

// The module list the worker compiles (its esbuild stdin), resolved relative to app/scripts.
const workerModules = () => {
  const stdin = worker.match(/stdin:\{contents:"([^"]+)"/)?.[1]
  assert.ok(stdin, 'opencode-assets.mjs compiles its kernel/collector from an esbuild stdin entry')
  return [...stdin.matchAll(/from '([^']+)'/g)].map((m) => resolve(here, m[1]))
}

test('one copy of each shared collector file is tracked, so desktop and headless cannot drift', () => {
  const tracked = execFileSync('git', ['ls-files'], { cwd: repo, encoding: 'utf8' }).split('\n')
  for (const name of SHARED) {
    const copies = tracked.filter((f) => basename(f) === name)
    assert.ok(copies.length >= 1, `${name} is tracked`)
    const bytes = copies.map((f) => readFileSync(join(repo, f)))
    for (const b of bytes) assert.ok(b.equals(bytes[0]), `${name} copies differ: ${copies.join(', ')}`)
  }
})

test('the worker compiles the same collector, agent adapter, kernel and completion modules as desktop', () => {
  const modules = workerModules()
  const main = join(repo, 'app/src/main')
  for (const file of ['research-collector.ts', 'research-agent.ts', 'kernel/opencode.ts', 'paper-build.ts', 'runtime-core.ts', 'opencode-install-core.ts'])
    assert.ok(modules.includes(join(main, file)), `worker bundles app/src/main/${file}`)
  const telemetry = readFileSync(join(main, 'telemetry.ts'), 'utf8')
  assert.match(telemetry, /from '\.\/research-collector'/)
  assert.match(telemetry, /from '\.\/research-agent'/)
  assert.match(readFileSync(join(main, 'index.ts'), 'utf8'), /from '\.\/paper-build'/)
  assert.match(readFileSync(join(main, 'research-collector.ts'), 'utf8'), /from '\.\.\/shared\/research-contract'/, 'collector validates with the vendored contract')
  assert.match(readFileSync(join(main, 'research-agent.ts'), 'utf8'), /from '\.\/research-collector'/, 'agent adapter writes through the collector')
})

test('vendored contract matches the canonical web contract', { skip: !process.env.HUMANSTUDY_WEB_CONTRACT && 'set HUMANSTUDY_WEB_CONTRACT to compare' }, () => {
  const web = readFileSync(process.env.HUMANSTUDY_WEB_CONTRACT)
  assert.ok(web.equals(readFileSync(join(repo, 'app/src/shared/research-contract.ts'))))
})

test('the worker certificate is the desktop completion check on the exact program bytes', async () => {
  const out = mkdtempSync(join(tmpdir(), 'headless-parity-'))
  const compiled = join(out, 'worker.mjs')
  const stdin = worker.match(/stdin:\{contents:"([^"]+)"/)[1]
  await build({ stdin: { contents: stdin, resolveDir: here, loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', target: 'node20', outfile: compiled, logLevel: 'error' })
  const { programCertificate, createResearchCollector, createResearchAgent } = await import(pathToFileURL(compiled).href)
  assert.equal(typeof createResearchCollector, 'function')
  assert.equal(typeof createResearchAgent, 'function')
  const project = join(out, 'project')
  mkdirSync(project)
  assert.equal(programCertificate(project), null, 'no program is never complete')
  const bytes = readFileSync(join(repo, 'app/src/main/fixtures/complete-program.json'))
  writeFileSync(join(project, 'program.json'), bytes)
  const complete = programCertificate(project)
  assert.deepEqual(complete.problems, [])
  assert.equal(complete.hash, createHash('sha256').update(bytes).digest('hex'))
  const thin = JSON.parse(bytes.toString('utf8'))
  thin.nodes = thin.nodes.filter((n) => n.id !== 'result')
  writeFileSync(join(project, 'program.json'), JSON.stringify(thin))
  assert.ok(programCertificate(project).problems.some((p) => p.startsWith('s1:')), 'missing results keep the build incomplete')
  assert.ok(existsSync(compiled))
})

test('the worker certifies after each finished turn and writes the result to its run log', () => {
  assert.match(worker, /event\.type==='done'\)\{certify\(/)
  assert.match(worker, /completion\.json/)
})
