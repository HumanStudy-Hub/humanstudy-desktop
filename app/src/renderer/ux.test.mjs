// Pure helpers of the researcher workspace: artifact kind/title detection, tool sentences, i18n parity.   node src/renderer/ux.test.mjs
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = mkdtempSync(join(tmpdir(), 'ux-test-'))
const entries = { results: 'results.ts', tool: 'toolSentence.ts', i18n: 'i18n.ts', dict: 'i18n-dict.ts', sections: 'program/sections.ts' }
await build({
  entryPoints: Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, join(here, v)])),
  bundle: true, platform: 'node', format: 'esm', outdir: out, logLevel: 'error', outExtension: { '.js': '.mjs' },
})
const load = (k) => import(pathToFileURL(join(out, `${k}.mjs`)).href)
const R = await load('results')
const T = await load('tool')
const I = await load('i18n')
const D = await load('dict')
const SEC = await load('sections')

// ---- results: which files, what kind, what title
assert.equal(R.resultKind('artifacts/flow.html'), 'chart')
assert.equal(R.resultKind('artifacts/a.png'), 'figure')
assert.equal(R.resultKind('artifacts/notes.md'), 'report')
assert.equal(R.resultKind('artifacts/d.csv'), 'table')
assert.equal(R.resultKind('artifacts/d.json'), 'data')
assert.equal(R.resultKind('artifacts/simulations/2026/report.md'), 'simulation')
assert.equal(R.resultKind('exports/preregistration.md'), 'draft')
assert.equal(R.resultKind('exports/summary.docx'), 'document')
assert.equal(R.deSlug('artifacts/2026-10-11-participant_flow.html'), 'Participant flow')
assert.equal(R.resultTitle('artifacts/x.html', '<html><title>Harm &amp; help</title><h1>Other</h1>'), 'Harm & help')
assert.equal(R.resultTitle('artifacts/x.html', '<body><h1 class="a">The <b>flow</b></h1>'), 'The flow')
assert.equal(R.resultTitle('artifacts/x.md', 'intro\n\n## Simulation *report*\ntext'), 'Simulation report')
assert.equal(R.resultTitle('artifacts/some-table.csv', 'a,b\n1,2'), 'Some table')
assert.equal(R.resultTitle('artifacts/x.json', '{"title":"Descriptives"}'), 'Descriptives')
assert.equal(R.resultTitle('artifacts/my_chart.html'), 'My chart')
assert.deepEqual(R.parseCsvHead('a,b\n"x,1","y ""q"""\n3,4\n', 2).rows, [['a', 'b'], ['x,1', 'y "q"']])

// ---- tool sentences
const dir = '/p'
const sent = (part) => { const s = T.toolSentence(T.classifyTool(part, dir)); return [s.key, s.vars?.page ?? s.vars?.title ?? s.vars?.host ?? s.muted ?? null] }
assert.deepEqual(sent({ tool: 'read', detail: 'paper.pdf · pages 3–4' }), ['tool.reading_paper_page', 3])
assert.deepEqual(sent({ tool: 'read', input: { filePath: '/p/paper.pdf' } }), ['tool.reading_paper', null])
assert.deepEqual(sent({ tool: 'bash', detail: 'pdftotext -f 5 -l 6 paper.pdf -' }), ['tool.reading_paper_page', 5])
assert.deepEqual(sent({ tool: 'read', detail: 'program.json' }), ['tool.reading_study', null])
assert.deepEqual(sent({ tool: 'write', input: { filePath: '/p/program.json' } }), ['tool.updating_study', null])
assert.deepEqual(sent({ tool: 'edit', detail: '--- a/program.json\n+++ b/program.json\n@@ -1 +1 @@\n-a\n+b' }), ['tool.updating_study', null])
assert.deepEqual(sent({ tool: 'write', input: { filePath: '/p/artifacts/participant-flow.html' } }), ['tool.creating', 'Participant flow'])
assert.deepEqual(sent({ tool: 'edit', input: { filePath: '/p/exports/prereg.md' } }), ['tool.updating', 'Prereg'])
for (const tool of ['glob', 'grep', 'list']) assert.deepEqual(sent({ tool, detail: '**/*' }), ['tool.looking', null])
assert.deepEqual(sent({ tool: 'bash', detail: 'ls -la' }), ['tool.looking', null])
assert.deepEqual(sent({ tool: 'bash', detail: 'mkdir -p artifacts' }), ['tool.folders', null])
assert.deepEqual(sent({ tool: 'bash', detail: 'python3 check_package.py package/x' }), ['tool.checking_package', null])
assert.deepEqual(sent({ tool: 'bash', detail: 'python3 analyze.py' }), ['tool.running_script', null])
assert.deepEqual(sent({ tool: 'bash', detail: 'curl example.org' }), ['tool.running_command', 'curl'])
assert.deepEqual(sent({ tool: 'webfetch', input: { url: 'https://doi.org/10.1/x' } }), ['tool.opening', 'doi.org'])
assert.deepEqual(sent({ tool: 'frobnicate' }), ['tool.working', 'frobnicate'])
for (const k of T.TOOL_KEYS) assert.ok(D.EN[k] && D.ZH[k], `missing tool key ${k}`)

// ---- i18n
const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',')
for (const [k, en] of Object.entries(D.EN)) {
  assert.ok(typeof D.ZH[k] === 'string' && D.ZH[k].length > 0, `zh missing: ${k}`)
  assert.equal(vars(D.ZH[k]), vars(en), `placeholders differ: ${k}`)
}
for (const k of Object.keys(D.ZH)) assert.ok(k in D.EN || k.startsWith('item.'), `zh-only key: ${k}`)
for (const sec of SEC.SECTIONS) {
  assert.ok(D.EN[`sec.${sec.id}`] && D.ZH[`sec.${sec.id}`], `section ${sec.id}`)
  for (const it of sec.items) assert.ok(D.ZH[`item.${sec.id}.${it.id}`], `item ${sec.id}.${it.id} has no Chinese label`)
}
assert.equal(I.resolveLang('system', 'zh-CN'), 'zh-CN')
assert.equal(I.resolveLang('system', 'zh-TW'), 'zh-CN')
assert.equal(I.resolveLang('system', 'en-US'), 'en')
assert.equal(I.resolveLang('en', 'zh-CN'), 'en')
assert.equal(I.translate('zh-CN', 'tool.reading_paper_page', { page: 3 }), '正在阅读论文（第 3 页）')
assert.equal(I.translate('en', 'tool.reading_paper_page', { page: 3 }), 'Reading the paper (p. 3)')
assert.equal(I.translate('zh-CN', 'no.such.key'), 'no.such.key')
console.log('ux tests passed')

// ---- missing = amber: detection and section counts
{
  const out2 = mkdtempSync(join(tmpdir(), 'amber-test-'))
  await build({ entryPoints: { missing: join(here, 'program/missing.ts') }, bundle: true, platform: 'node', format: 'esm', outdir: out2, logLevel: 'error', outExtension: { '.js': '.mjs' } })
  const M = await import(pathToFileURL(join(out2, 'missing.mjs')).href)
  assert.equal(M.fieldNeed({ state: 'missing', value: null }), 'missing')
  assert.equal(M.fieldNeed({ state: 'decision', value: 'x' }), 'decision')
  assert.equal(M.fieldNeed({ state: 'confirmed', value: '[填写]' }), 'missing')
  assert.equal(M.fieldNeed({ state: 'check', value: 'N = [填写] participants' }), 'missing')
  assert.equal(M.fieldNeed({ state: 'confirmed', value: 'TBD' }), 'missing')
  assert.equal(M.fieldNeed({ state: 'confirmed', value: '' }), 'missing')
  assert.equal(M.fieldNeed({ state: 'confirmed', value: 'Adults, n = 120' }), null)
  assert.equal(M.fieldNeed({ state: 'check', value: 42 }), null)
  const sample = JSON.parse((await import('node:fs')).readFileSync(join(here, '../shared/sample-program.json'), 'utf8'))
  const counts = M.amberCounts(sample, sample.studies[0].id)
  assert.equal(counts.total, Object.values(counts.bySection).reduce((a, b) => a + b, 0))
  assert.ok(counts.total > 0 && counts.first, 'sample program has amber items')
  assert.equal(M.amberCounts({ ...sample, nodes: [], steps: [] }, sample.studies[0].id).total, 0)
}
console.log('amber ok')
