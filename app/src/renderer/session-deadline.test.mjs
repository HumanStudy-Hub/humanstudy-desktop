// The online session's time-left notice: node --test src/renderer/session-deadline.test.mjs
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const out = mkdtempSync(join(tmpdir(), 'session-deadline-'))
await build({ entryPoints: [join(here, 'session-deadline.ts'), join(here, 'i18n.ts')], bundle: true, platform: 'node', format: 'esm', outdir: out, logLevel: 'error' })
const { sessionDeadline, deadlineNotice } = await import(pathToFileURL(join(out, 'session-deadline.js')).href)
const { translate } = await import(pathToFileURL(join(out, 'i18n.js')).href)
rmSync(out, { recursive: true, force: true })

test('the deadline runs on the page clock from the time left the server sent', () => {
  assert.equal(sessionDeadline(600_000, 1_000), 601_000)
  assert.equal(sessionDeadline(0, 1_000), 1_000)
  for (const value of [undefined, null, -1, '600000', Number.NaN]) assert.equal(sessionDeadline(value, 1_000), null)
})

test('nothing above 10 minutes, minutes left up to 2, then the final notice', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 })
  const deadline = sessionDeadline(45 * 60_000)
  const at = minutes => { t.mock.timers.setTime(deadline - minutes * 60_000); return deadlineNotice(deadline - Date.now()) }
  assert.equal(at(30), null)
  assert.equal(at(10.01), null)
  assert.deepEqual(at(10), { minutes: 10, final: false })
  assert.deepEqual(at(4.5), { minutes: 5, final: false })
  assert.deepEqual(at(2.01), { minutes: 3, final: false })
  assert.deepEqual(at(2), { minutes: 2, final: true })
  assert.deepEqual(at(0), { minutes: 1, final: true })
})

test('both notices exist in English and Chinese', () => {
  assert.equal(translate('en', 'session.ends_in', { n: 7 }), 'Session ends in 7 min')
  assert.equal(translate('zh-CN', 'session.ends_in', { n: 7 }), '会话将在 7 分钟后结束')
  assert.equal(translate('en', 'session.ending'), 'Your work will be saved automatically. The session ends in under 2 minutes; you can reopen it from the Hub.')
  assert.equal(translate('zh-CN', 'session.ending'), '你的工作会自动保存。会话将在 2 分钟内结束，之后可以从 Hub 重新打开。')
})
