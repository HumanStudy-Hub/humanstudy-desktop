import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
const here = dirname(fileURLToPath(import.meta.url))
const temp = await mkdtemp(join(tmpdir(), 'run-notice-'))
await build({ entryPoints: [join(here, 'package-readiness.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(temp, 'readiness.mjs') })
const { communityRunNotice, COMMUNITY_RUN_NOTICE } = await import(pathToFileURL(join(temp, 'readiness.mjs')))
test('community forks display the key notice; local flags cannot attest maintainer review', async () => {
  const project = join(temp, 'project')
  await mkdir(join(project, '.humanstudy'), { recursive: true })
  assert.equal(await communityRunNotice(project), undefined)
  for (const contents of ['{}', '{"baseRevision":"abc","reviewed":true}', 'malformed']) {
    await writeFile(join(project, '.humanstudy/community.json'), contents)
    assert.equal(await communityRunNotice(project), COMMUNITY_RUN_NOTICE)
  }
})
test('revisions opened with Open folder are recognised by their package metadata', async () => {
  const cases = [
    ['sources/study.json', JSON.stringify({ id: 'paper_x', baseRevision: 'abc', commit: 'f'.repeat(40) })],
    ['sources/study.json', JSON.stringify({ id: 'study_014', repoUrl: 'https://example.org', commit: 'f'.repeat(40) })],
    ['sources/study.json', 'not json'],
    ['CONTRIBUTION.json', JSON.stringify({ schemaVersion: 2, baseRevision: null })],
    ['scripts/study_core.py', ''],
  ]
  for (const [i, [file, contents]] of cases.entries()) {
    const project = join(temp, `open-${i}`)
    await mkdir(join(project, dirname(file)), { recursive: true })
    await writeFile(join(project, 'program.json'), '{}')
    await writeFile(join(project, file), contents)
    assert.equal(await communityRunNotice(project), COMMUNITY_RUN_NOTICE, file + ' ' + contents)
  }
  const own = join(temp, 'own')
  await mkdir(join(own, 'sources'), { recursive: true })
  await writeFile(join(own, 'program.json'), '{}')
  await writeFile(join(own, 'sources/notes.json'), '{}')
  assert.equal(await communityRunNotice(own), undefined, 'a study built here is not a revision')
})
test.after(() => rm(temp, { recursive: true, force: true }))
