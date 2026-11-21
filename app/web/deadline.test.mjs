// The provider deadline helpers, on fake timers: node --test web/deadline.test.mjs
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const { LEAD_MS, parseDeadline, armDeadline } = createRequire(import.meta.url)('./deadline.cjs')
const now = Date.parse('2026-11-20T10:00:00.000Z')

test('only a plausible future ISO time is a deadline', () => {
  assert.equal(parseDeadline('2026-11-20T10:45:00.000Z', now), now + 45 * 60_000)
  assert.equal(parseDeadline('2026-11-20T18:45:00+08:00', now), now + 45 * 60_000)
  for (const value of [undefined, '', 'soon', '2700000', '2026-11-20T09:59:59.000Z', '2026-11-20T10:00:00.000Z',
    '2026-11-25T10:00:00.000Z', 'Fri, 20 Nov 2026 10:45:00 GMT', '2026-11-20T10:45:00'])
    assert.equal(parseDeadline(value, now), undefined, String(value))
})

test('the stop fires once, 25 s before the deadline', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now })
  let fired = 0
  armDeadline(now + 45 * 60_000, () => fired++, { now })
  t.mock.timers.tick(45 * 60_000 - LEAD_MS - 1)
  assert.equal(fired, 0)
  t.mock.timers.tick(1)
  assert.equal(fired, 1)
  t.mock.timers.tick(60 * 60_000)
  assert.equal(fired, 1)
})

test('a deadline already inside the lead stops at once; a cancelled or absent one never', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now })
  let late = 0, cancelled = 0
  armDeadline(now + 10_000, () => late++, { now })
  const cancel = armDeadline(now + 60_000, () => cancelled++, { now })
  cancel()
  armDeadline(undefined, () => assert.fail('no deadline'), { now })
  t.mock.timers.tick(0)
  assert.equal(late, 1)
  t.mock.timers.tick(120_000)
  assert.equal(cancelled, 0)
})
