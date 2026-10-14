// Tolerant loader + strict validator + parity with pack/skills/build/check_program.py.   node src/shared/human-program.test.mjs
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = mkdtempSync(join(tmpdir(), 'hp-test-'))
await build({ entryPoints: [join(here, 'human-program.ts')], bundle: true, platform: 'node', format: 'esm', outdir: out, logLevel: 'error', outExtension: { '.js': '.mjs' } })
const { validateHumanProgram: strict, readHumanProgram: tolerant } = await import(pathToFileURL(join(out, 'human-program.mjs')).href)
const fx = (n) => JSON.parse(readFileSync(join(here, 'fixtures', n), 'utf8'))
const sample = JSON.parse(readFileSync(join(here, 'sample-program.json'), 'utf8'))
const ok = (p) => { try { strict(p); return true } catch { return false } }
const mut = (f, base = sample) => { const p = structuredClone(base); f(p); return p }

// ---- fixtures: [name, program, strict-valid?]
const broken = fx('fce-broken.json')
const repaired = tolerant(broken).program
writeFileSync(join(here, 'fixtures', 'fce-repaired.json'), JSON.stringify(repaired, null, 2) + '\n')
const step = sample.steps[0], node = sample.nodes.find((n) => n.fields.length)
const cases = [
  ['fce-broken', broken, false],
  ['fce-repaired', fx('fce-repaired.json'), true],
  ['knobe-e2e', fx('knobe-e2e.json'), false], // evidence without any source reference
  ['sample', sample, true],
  ['dup-node', mut((p) => p.nodes.push(structuredClone(p.nodes[0]))), false],
  ['unknown-evidence', mut((p) => p.nodes[0].evidenceIds.push('nope')), false],
  ['issue-nodeId-is-step', mut((p) => p.issues.push({ id: 'iss-x', title: 't', severity: 'check', reason: 'r', impact: 'i', suggestedAction: 'a', nodeId: step.id, evidenceIds: [] })), false],
  ['issue-nodeId-is-study', mut((p) => p.issues.push({ id: 'iss-x', title: 't', severity: 'check', reason: 'r', impact: 'i', suggestedAction: 'a', nodeId: p.studies[0].id, evidenceIds: [] })), false],
  ['issue-bad-field', mut((p) => p.issues.push({ id: 'iss-x', title: 't', severity: 'check', reason: 'r', impact: 'i', suggestedAction: 'a', nodeId: node.id, fieldId: 'zzz', evidenceIds: [] })), false],
  ['step-bad-next', mut((p) => p.steps[0].next.push({ to: 'ghost' })), false],
  ['bad-condition', mut((p) => { p.nodes.find((n) => n.kind !== 'condition').conditionIds = [p.nodes.find((n) => n.kind !== 'condition' && n !== node).id] }), false],
  ['containment-cycle', mut((p) => { p.steps[0].children = [p.steps[0].id] }), false],
  ['unresolved-no-issue', mut((p) => { p.issues = p.issues.filter((i) => !i.nodeId); p.nodes.forEach((n) => n.fields.forEach((f) => { f.state = 'missing' })) }), false],
  ['derived-no-derivation', mut((p) => { const f = node.fields[0]; const g = p.nodes.find((n) => n.id === node.id).fields[0]; g.origin = 'derived'; delete g.derivation; void f }), false],
]
const expectInvalid = ['dup-node', 'unknown-evidence', 'issue-nodeId-is-step', 'issue-nodeId-is-study', 'issue-bad-field', 'step-bad-next', 'bad-condition', 'containment-cycle', 'unresolved-no-issue', 'derived-no-derivation']
for (const [name, p, valid] of cases) {
  if (expectInvalid.includes(name)) assert.equal(ok(p), false, `${name} should be invalid under strict`)
  else assert.equal(ok(p), valid, `${name} strict verdict`)
}

// ---- parity with the Python self-check
const py = spawnSync('python3', ['--version'])
if (py.status !== 0) console.log('python3 unavailable: parity skipped')
else {
  const script = join(here, '../../../pack/skills/build/check_program.py')
  for (const [name, p] of cases) {
    const f = join(out, `${name}.json`)
    writeFileSync(f, JSON.stringify(p))
    const r = spawnSync('python3', ['-I', script, f], { encoding: 'utf8' })
    assert.equal(r.status === 0, ok(p), `parity ${name}: python=${r.status} ts=${ok(p)}\n${r.stdout}${r.stderr}`)
    if (name === 'fce-broken') {
      assert.match(r.stdout, /iss-s4-script: unknown reference s4-field-request/)
      assert.match(r.stdout, /use stepId/)
      assert.equal((r.stdout.match(/^PROBLEM/gm) ?? []).length, 3, 'prints every problem, not just the first')
    }
  }
  // Python mentions the same problem set as the collector for the broken file.
  console.log('parity ok over', cases.length, 'programs')
}

// ---- tolerant loader
{
  const r = tolerant(broken)
  assert.equal(r.problems.length, 3)
  assert.ok(r.problems.some((x) => /s4-field-request.*use stepId/.test(x)))
  const issue = r.program.issues.find((i) => i.id === 'iss-s4-script')
  assert.equal(issue.stepId, 's4-field-request'); assert.equal(issue.nodeId, undefined)
  assert.equal(r.program.issues.length, broken.issues.length + 2) // two synthesised check issues
  const added = r.program.issues.slice(-2)
  assert.ok(added.every((i) => i.severity === 'check'))
  assert.ok(added.some((i) => i.nodeId === 'cond-s3-repent' && i.fieldId === 'assignment'))
  assert.doesNotThrow(() => strict(r.program))
  assert.equal(broken.issues.find((i) => i.id === 'iss-s4-script').nodeId, 's4-field-request', 'input is not mutated')
}
{
  const r = tolerant(mut((p) => p.issues.push({ id: 'iss-x', title: 't', severity: 'check', reason: 'r', impact: 'i', suggestedAction: 'a', nodeId: sample.studies[0].id, evidenceIds: [] })))
  assert.equal(r.program.issues.at(-1).studyId, sample.studies[0].id)
  assert.equal(r.problems.length, 1)
}
{
  const r = tolerant(mut((p) => { p.nodes[0].evidenceIds.push('nope'); p.steps[0].next.push({ to: 'ghost' }); p.steps[0].actorIds.push('ghost'); p.relations.push({ id: 'rel-x', from: 'ghost', to: p.nodes[0].id, type: 't' }) }))
  assert.equal(r.problems.length, 4)
  assert.ok(!r.program.nodes[0].evidenceIds.includes('nope'))
  assert.ok(!r.program.steps[0].next.some((e) => e.to === 'ghost'))
  assert.ok(!r.program.relations.some((x) => x.id === 'rel-x'))
  assert.doesNotThrow(() => strict(r.program))
}
{
  const r = tolerant(mut((p) => { p.steps[0].children = [p.steps[0].id] }))
  assert.equal(r.problems.length, 1); assert.doesNotThrow(() => strict(r.program))
}
{
  const r = tolerant(mut((p) => { p.issues = []; p.nodes.forEach((n) => n.fields.forEach((f) => { f.state = 'missing' })) }))
  assert.ok(r.problems.length > 0 && r.program.issues.length === r.problems.length); assert.doesNotThrow(() => strict(r.program))
}
assert.deepEqual(tolerant(sample).problems, [])
assert.throws(() => tolerant(null), /JSON object/)
assert.throws(() => tolerant([]), /JSON object/)
assert.throws(() => tolerant({ ...sample, schemaVersion: 1 }), /schemaVersion/)
console.log('human-program ok')
