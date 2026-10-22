// A single-field save patches program.json on disk and nothing else (issue #17).   node src/shared/program-patch.test.mjs
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = mkdtempSync(join(tmpdir(), 'patch-test-'))
await build({ entryPoints: [join(here, 'program-patch.ts'), join(here, 'human-program.ts')], bundle: true, platform: 'node', format: 'esm', outdir: out, logLevel: 'error', outExtension: { '.js': '.mjs' } })
const { patchProgramField, parseWithSpans } = await import(pathToFileURL(join(out, 'program-patch.mjs')).href)
const { readHumanProgram } = await import(pathToFileURL(join(out, 'human-program.mjs')).href)
const sample = JSON.parse(readFileSync(join(here, 'sample-program.json'), 'utf8'))

/** The tester's file: a duplicated entry, a step in a study that does not exist, a cross-study flow link. */
function malformed() {
  const p = structuredClone(sample)
  const dup = structuredClone(p.nodes.find((n) => n.kind === 'background'))
  dup.title = 'Second copy, kept on disk'
  p.nodes.push(dup)
  p.steps.find((s) => s.id === 'exp-2-read').studyId = 'exp-9'
  p.steps.find((s) => s.id === 'exp-1-read').next.push({ to: 'exp-2-answer' })
  return p
}

/** Everything outside [start, end) must be byte-identical. */
function onlyChangedWithin(before, after, start, endFromTail) {
  assert.equal(after.slice(0, start), before.slice(0, start))
  assert.equal(after.slice(after.length - endFromTail), before.slice(before.length - endFromTail))
}

test('saving "Background and gap" leaves duplicates, step ownership and flow links on disk alone', () => {
  const p = malformed()
  // The tolerant reader would have dropped the duplicate, moved the step and cleared the link.
  const { program: normalised, problems } = readHumanProgram(p)
  assert.ok(problems.length >= 3)
  assert.equal(normalised.nodes.filter((n) => n.kind === 'background').length, 1)

  const raw = JSON.stringify(p, null, 4).replace(/\n/g, '\r\n') + '\r\n' // agent formatting, Windows line ends
  const next = patchProgramField(raw, { id: 'background', fieldId: 'gap', value: 'Prior work did not test X.' })
  const saved = JSON.parse(next)

  // The edited field changed, on the first entry of the duplicated id (the one the reader shows).
  const gap = saved.nodes.find((n) => n.id === 'background').fields.find((f) => f.id === 'gap')
  assert.deepEqual([gap.value, gap.origin, gap.state], ['Prior work did not test X.', 'researcher', 'confirmed'])

  // Nothing else did: same document with that one field put back.
  const back = structuredClone(saved)
  Object.assign(back.nodes.find((n) => n.id === 'background').fields.find((f) => f.id === 'gap'), { value: p.nodes.find((n) => n.id === 'background').fields.find((f) => f.id === 'gap').value, origin: 'unknown', state: 'missing' })
  assert.deepEqual(back, p)
  assert.equal(saved.nodes.filter((n) => n.id === 'background').length, 2)
  assert.equal(saved.nodes.at(-1).title, 'Second copy, kept on disk')
  assert.equal(saved.steps.find((s) => s.id === 'exp-2-read').studyId, 'exp-9')
  assert.ok(saved.steps.find((s) => s.id === 'exp-1-read').next.some((e) => e.to === 'exp-2-answer'))

  // Byte level: everything before the field and after it is identical, CRLF and 4-space indent included.
  const root = parseWithSpans(raw)
  const nodes = root.members.find((m) => m.key === 'nodes').value
  const field = nodes.items.find((n) => n.members.find((m) => m.key === 'id').value.value === 'background').members.find((m) => m.key === 'fields').value.items.find((f) => f.members.find((m) => m.key === 'id').value.value === 'gap')
  onlyChangedWithin(raw, next, field.start, raw.length - field.end)
  assert.equal(next.split('\r\n').length, raw.split('\r\n').length)
  assert.ok(!/[^\r]\n/.test(next))
})

test('a flow rule edit patches only that step’s rule', () => {
  const raw = JSON.stringify(malformed(), null, 2) + '\n'
  const next = patchProgramField(raw, { id: 'flow:exp-1-answer', fieldId: 'rule', value: 'Answer once.' })
  const a = JSON.parse(raw), b = JSON.parse(next)
  assert.equal(b.steps.find((s) => s.id === 'exp-1-answer').rule.value, 'Answer once.')
  b.steps.find((s) => s.id === 'exp-1-answer').rule = a.steps.find((s) => s.id === 'exp-1-answer').rule
  assert.deepEqual(b, a)
})

test('unchanged keys are not touched, and a field that is gone is an error, not a rewrite', () => {
  const raw = JSON.stringify(sample)
  const once = patchProgramField(raw, { id: 'background', fieldId: 'gap', value: 'x' })
  assert.equal(patchProgramField(once, { id: 'background', fieldId: 'gap', value: 'x' }), once)
  assert.throws(() => patchProgramField(raw, { id: 'background', fieldId: 'nope', value: 'x' }), /is not in program\.json/)
  assert.throws(() => patchProgramField(raw, { id: 'flow:nope', fieldId: 'rule', value: 'x' }), /is not in program\.json/)
})

test('the span parser agrees with JSON.parse on escapes, numbers and repeated keys', () => {
  const raw = '{"a":"q\\"\\u00e9\\\\","n":[-1.5e3,0,true,null],"k":1,"k":{"x":[]}}'
  const root = parseWithSpans(raw)
  const strip = (n) => n.kind === 'object' ? Object.fromEntries(n.members.map((m) => [m.key, strip(m.value)])) : n.kind === 'array' ? n.items.map(strip) : n.value
  assert.deepEqual(strip(root), JSON.parse(raw))
  assert.throws(() => parseWithSpans('{"a":1,}'))
  assert.throws(() => parseWithSpans('{"a":1} x'))
})
