import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { packHash, webManifest } from './web-manifest.mjs'

test('pack identity is deterministic and changes only for bundled paths and bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'hs-pack-manifest-'))
  try {
    mkdirSync(join(root, 'skills/build/__pycache__'), { recursive: true })
    mkdirSync(join(root, 'runtime/hsenv'), { recursive: true })
    writeFileSync(join(root, 'AGENTS.md'), 'study instructions')
    writeFileSync(join(root, 'skills/build/SKILL.md'), 'build')
    writeFileSync(join(root, 'runtime/hsenv/VERSION'), '0.8.1')
    const hash = packHash(root)
    assert.equal(packHash(root), hash)
    writeFileSync(join(root, 'skills/build/__pycache__/cached.pyc'), 'cache')
    writeFileSync(join(root, 'README.md'), 'not installed')
    assert.equal(packHash(root), hash)
    writeFileSync(join(root, 'skills/build/SKILL.md'), 'changed instructions')
    assert.notEqual(packHash(root), hash)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('tagged builds reject version mismatch and dirty source; manifest contains only public identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'hs-source-manifest-'))
  const prior = { type: process.env.GITHUB_REF_TYPE, name: process.env.GITHUB_REF_NAME }
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  try {
    mkdirSync(join(root, 'pack'))
    writeFileSync(join(root, 'pack/AGENTS.md'), 'test')
    git('init'); git('add', 'pack')
    git('-c', 'user.name=Build test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture')
    process.env.GITHUB_REF_TYPE = 'tag'; process.env.GITHUB_REF_NAME = 'v0.8.0'
    const manifest = webManifest(root, '0.8.0')
    assert.deepEqual(Object.keys(manifest), ['version', 'gitsha', 'packhash', 'dirty'])
    assert.equal(manifest.gitsha, git('rev-parse', 'HEAD'))
    assert.equal(manifest.dirty, false)
    assert.throws(() => webManifest(root, '0.7.0'), /Release tag/)
    writeFileSync(join(root, 'pack/AGENTS.md'), 'uncommitted change')
    assert.throws(() => webManifest(root, '0.8.0'), /clean source/)
    process.env.GITHUB_REF_TYPE = 'branch'
    assert.equal(webManifest(root, '0.8.0').dirty, true)
  } finally {
    for (const [key, value] of [['GITHUB_REF_TYPE', prior.type], ['GITHUB_REF_NAME', prior.name]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
    rmSync(root, { recursive: true, force: true })
  }
})
