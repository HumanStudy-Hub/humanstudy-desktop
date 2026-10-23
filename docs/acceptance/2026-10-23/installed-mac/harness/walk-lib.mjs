// Shared setup for the installed-app walkthrough: isolated profile, mock HumanStudy/Supabase
// server (UI-only checks; no real account, no real research delivery), mock kernel.
import { _electron } from 'playwright-core'
import { createServer } from 'node:http'
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
export const A = process.env.HS_ACCEPT_DIR
export const EXE = A + '/install/HumanStudy Hub.app/Contents/MacOS/HumanStudy Hub'
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
export const USER = '00000000-0000-4000-8000-0000000acce5'
export const fakeJwt = () => `${b64({ alg: 'none' })}.${b64({ sub: USER, email: 'walkthrough@acceptance.humanstudy.invalid', exp: Math.floor(Date.now() / 1000) + 86400 })}.sig`

export async function mockServer(log) {
  const hits = []
  const srv = createServer(async (req, res) => {
    let body = 0; for await (const c of req) body += c.length
    const u = new URL(req.url, 'http://x'); hits.push({ method: req.method, path: u.pathname, bytes: body })
    appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), method: req.method, path: u.pathname, bytes: body }) + '\n')
    const json = (code, v) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)) }
    if (u.pathname === '/api/desktop/config') return json(200, { supabaseUrl: origin, supabaseKey: 'mock-publishable', defaultModel: 'anthropic/claude-haiku-5.5', models: ['anthropic/claude-haiku-5.5'] })
    if (u.pathname === '/auth/v1/user') return json(200, { id: USER, email: 'walkthrough@acceptance.humanstudy.invalid' })
    if (u.pathname.startsWith('/rest/v1/')) return req.method === 'GET' ? json(200, []) : json(201, [])
    return json(200, {})
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const origin = `http://127.0.0.1:${srv.address().port}`
  return { origin, hits, close: () => srv.close() }
}

export async function launch(ud, origin, extraEnv = {}) {
  return _electron.launch({ executablePath: EXE, args: ['--user-data-dir=' + ud], env: { ...process.env, HUMANSTUDY_KERNEL: 'mock', HUMANSTUDY_SERVER: origin, ...extraEnv } })
}

/** Fresh isolated profile with a synthetic signed-in account (encrypted by the installed app itself). */
export async function freshProfile(name, origin) {
  const ud = `${A}/walk-${name}`; rmSync(ud, { recursive: true, force: true }); mkdirSync(ud + '/projects', { recursive: true })
  writeFileSync(ud + '/settings.json', JSON.stringify({ projectsRoot: ud + '/projects', notifications: false, language: 'en' }))
  const app = await launch(ud, origin)
  await app.firstWindow()
  await app.evaluate(({ safeStorage, app }, { jwt, origin }) => {
    const enc = (v) => safeStorage.encryptString(JSON.stringify(v)).toString('base64')
    require('node:fs').writeFileSync(app.getPath('userData') + '/account.json', JSON.stringify({
      session: enc({ accessToken: jwt, refreshToken: 'walkthrough-no-refresh', expiresAt: Date.now() + 86400000, email: 'walkthrough@acceptance.humanstudy.invalid' }),
      desktopKey: enc({ key: 'walkthrough-mock-key', expiresAt: new Date(Date.now() + 86400000).toISOString() }),
      config: { supabaseUrl: origin, supabaseKey: 'mock-publishable', defaultModel: 'anthropic/claude-haiku-5.5', models: ['anthropic/claude-haiku-5.5'] },
    }), { mode: 0o600 })
  }, { jwt: fakeJwt(), origin }).catch(async (e) => {
    // `require` is not defined in the evaluate scope; fall back to process.mainModule.
    await app.evaluate(({ safeStorage, app }, { jwt, origin }) => {
      const fs = process.mainModule.require('node:fs')
      const enc = (v) => safeStorage.encryptString(JSON.stringify(v)).toString('base64')
      fs.writeFileSync(app.getPath('userData') + '/account.json', JSON.stringify({
        session: enc({ accessToken: jwt, refreshToken: 'walkthrough-no-refresh', expiresAt: Date.now() + 86400000, email: 'walkthrough@acceptance.humanstudy.invalid' }),
        desktopKey: enc({ key: 'walkthrough-mock-key', expiresAt: new Date(Date.now() + 86400000).toISOString() }),
        config: { supabaseUrl: origin, supabaseKey: 'mock-publishable', defaultModel: 'anthropic/claude-haiku-5.5', models: ['anthropic/claude-haiku-5.5'] },
      }), { mode: 0o600 })
    }, { jwt: fakeJwt(), origin })
  })
  await app.close()
  return ud
}
export const text = (w) => w.evaluate(() => document.body.innerText)
export const until = async (fn, label, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v } catch {} await new Promise((r) => setTimeout(r, 250)) } throw Error('Timeout: ' + label) }
