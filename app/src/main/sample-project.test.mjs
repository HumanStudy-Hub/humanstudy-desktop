import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import { test } from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = join(here, '../..')
const assets = join(appRoot, 'resources/sample')
const bundleDir = mkdtempSync(join(tmpdir(), 'sample-project-test-'))
const source = readFileSync(join(here, 'sample-project.ts'), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText
await (await import('node:fs/promises')).writeFile(join(bundleDir, 'sample-project.mjs'), compiled)
const { installSampleAssets } = await import(pathToFileURL(join(bundleDir, 'sample-project.mjs')).href)
const program = JSON.parse(readFileSync(join(appRoot, 'src/shared/sample-program.json'), 'utf8'))

test('installs the original paper and all exact evidence resources with resolvable program references', async () => {
  const project = mkdtempSync(join(tmpdir(), 'sample-project-'))
  try {
    await installSampleAssets(assets, project)
    assert.deepEqual(readFileSync(join(project, 'paper.pdf')).subarray(0, 5), Buffer.from('%PDF-'))
    assert.deepEqual(readFileSync(join(project, 'KNOBE.pdf')), readFileSync(join(assets, 'KNOBE.pdf')))
    assert.equal(program.source.filename, 'KNOBE.pdf')
    const example = join(project, 'artifacts/simulations/2026-10-15-1329-example')
    for (const f of ['results.html', 'summary.json', 'progress.json', 'report.md']) assert.ok(existsSync(join(example, f)), `example run lacks ${f}`)
    assert.equal(JSON.parse(readFileSync(join(example, 'summary.json'), 'utf8')).example, true)
    assert.match(readFileSync(join(example, 'results.html'), 'utf8'), /not human data/i)
    assert.ok(existsSync(join(project, program.source.filename)))
    for (const evidence of program.evidence) {
      const filename = evidence.path
      assert.ok(existsSync(join(project, filename)), `missing resource ${filename}`)
      const material = JSON.parse(readFileSync(join(project, filename), 'utf8'))
      assert.equal(evidence.locator.pointer, '/instructions')
      assert.equal(material.instructions, evidence.quote, `${filename} evidence quote mismatch`)
    }
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('fails clearly when any required source asset is absent', async () => {
  const incomplete = mkdtempSync(join(tmpdir(), 'sample-assets-'))
  const project = mkdtempSync(join(tmpdir(), 'sample-project-'))
  try {
    await assert.rejects(installSampleAssets(incomplete, project), /required sample asset is missing or unreadable: KNOBE\.pdf/)
    assert.deepEqual(await (await import('node:fs/promises')).readdir(project), [])
  } finally {
    rmSync(incomplete, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})

test('preserves an existing edited resource and preflights before copying any sample assets', async () => {
  const project = mkdtempSync(join(tmpdir(), 'sample-project-'))
  const edited = join(project, 'experiment_1_help.json')
  writeFileSync(edited, '{"researcherEdit":true}\n')
  try {
    await assert.rejects(installSampleAssets(assets, project), /destination already exists and will be preserved/)
    assert.equal(readFileSync(edited, 'utf8'), '{"researcherEdit":true}\n')
    assert.equal(existsSync(join(project, 'KNOBE.pdf')), false)
    assert.equal(existsSync(join(project, 'paper.pdf')), false)
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})
