// Allowance wording: node src/renderer/allowance.test.mjs
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
const out = mkdtempSync(join(tmpdir(), 'allowance-'))
try {
  await build({ entryPoints: [join(here, 'allowance.ts'), join(here, 'i18n-dict.ts')], bundle: true, platform: 'node', format: 'esm', outdir: out, logLevel: 'error' })
  const { allowanceMessage } = await import(pathToFileURL(join(out, 'allowance.js')).href)
  const a = (o) => ({ available: true, percentLeft: 50, requestsLeft: 10, revoked: false, expired: false, ...o })
  assert.equal(allowanceMessage(null, 'settings'), null)
  assert.equal(allowanceMessage(a({ available: false }), 'settings'), null)
  assert.deepEqual(allowanceMessage(a({ percentLeft: 87 }), 'settings'), { key: 'settings.allowance', vars: { n: 87 } })
  assert.equal(allowanceMessage(a({ percentLeft: 87 }), 'chat'), null)
  assert.deepEqual(allowanceMessage(a({ percentLeft: 12 }), 'chat'), { key: 'chat.allowance_low', vars: { n: 12 } })
  for (const where of ['settings', 'chat']) {
    assert.deepEqual(allowanceMessage(a({ percentLeft: 0, revoked: true }), where), { key: 'allowance.ended' })
    assert.deepEqual(allowanceMessage(a({ percentLeft: 0, expired: true }), where), { key: 'allowance.ended' })
  }
  // Every key used here has en and zh text.
  const src = await import('node:fs').then((fs) => fs.readFileSync(join(here, 'i18n-dict.ts'), 'utf8'))
  for (const key of ['allowance.ended', 'settings.allowance', 'chat.allowance_low'])
    assert.match(src, new RegExp(`\\['${key.replace('.', '\\.')}', '[^']+', '[^']+'\\]`), key)
  console.log('allowance ok')
} finally {
  rmSync(out, { recursive: true, force: true })
}
