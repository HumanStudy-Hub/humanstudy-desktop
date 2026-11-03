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
test.after(() => rm(temp, { recursive: true, force: true }))
