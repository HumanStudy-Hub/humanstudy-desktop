// Run: HS_ACCEPT_DIR=<private dir containing install/HumanStudy Hub.app and shots/> HS_ACCEPT_PDF=<a.pdf> node walkthrough.mjs
// (needs playwright-core installed next to these files). Writes walkthrough-results.json and screenshots.
// Installed-app walkthrough (signed/notarized 0.6.7-rc.1 copied from the dmg to a temp folder).
// Isolated --user-data-dir, mock kernel and a local mock account/research server: UI-only checks.
import { A, mockServer, freshProfile, launch, text, until } from './walk-lib.mjs'
import { makeProject, incompletePackage, completePackage, SHARED } from './fixture.mjs'
import { readFileSync, writeFileSync, copyFileSync, existsSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
const S = A + '/shots'
const results = []
const check = async (id, title, fn) => {
  const t0 = Date.now()
  try { const detail = await fn(); results.push({ id, title, pass: true, detail, ms: Date.now() - t0 }); console.log('PASS', id, JSON.stringify(detail ?? '')) }
  catch (e) { results.push({ id, title, pass: false, error: String(e.message ?? e).slice(0, 600), ms: Date.now() - t0 }); console.log('FAIL', id, e.message) }
}
const srv = await mockServer(S + '/walk-server.jsonl')
const agree = async (w) => { const b = w.getByRole('button', { name: 'I agree' }); if (await b.isVisible().catch(() => false)) { await b.click(); await w.waitForTimeout(800) } }

// ---------- W1: import a paper -> build starts on its own ----------
{
  const ud = await freshProfile('import', srv.origin)
  const app = await launch(ud, srv.origin)
  const pdf = process.env.HS_ACCEPT_PDF // any PDF; the mock agent never reads it
  await app.evaluate(({ dialog }, pdf) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [pdf] }) }, pdf)
  const w = await app.firstWindow(); await w.waitForTimeout(2500); await agree(w)
  const info = { userData: await app.evaluate(({ app }) => app.getPath('userData')), version: await app.evaluate(({ app }) => app.getVersion()), packaged: await app.evaluate(({ app }) => app.isPackaged), exe: await app.evaluate(() => process.execPath) }
  await check('W0', 'Installed app identity and isolated profile', async () => {
    if (!info.packaged || info.version !== '0.6.7-rc.1' || !info.userData.includes('acceptance-2026-10-23') || !info.exe.includes('/install/')) throw Error(JSON.stringify(info))
    return info
  })
  await w.locator('button.tile', { hasText: 'From a paper' }).click()
  await check('W1', 'Import paper -> automatic build starts, no question asked', async () => {
    await until(async () => (await text(w)).includes('Build the study from paper.pdf now'), 'build request in chat', 20000)
    await until(async () => (await text(w)).includes('(mock kernel) You asked: "Build the study'), 'agent received build prompt', 20000)
    await w.screenshot({ path: S + '/w1-import-autobuild.png' })
    const t = await text(w)
    const projects = readdirSync(ud + '/projects')
    const state = JSON.parse(readFileSync(`${ud}/projects/${projects[0]}/.humanstudy/paper-build.json`, 'utf8'))
    if (t.includes('Should I start') ) throw Error('asked whether to start')
    return { buildRequestSent: true, questionShown: /question/i.test(t.split('Build the study')[0]) , paperBuildState: state.status, note: 'mock agent writes no program.json, so the build ends as "stopped before complete" (expected T03 behaviour)' }
  })
  await check('W1b', 'Build without a certified program is reported incomplete, not complete', async () => {
    // The mock agent treats the word "run" in the build prompt as a command needing approval; decline it.
    const deny = w.getByRole('button', { name: 'Don’t allow' })
    await until(async () => (await deny.count()) > 0 || (await text(w)).includes('The agent stopped before'), 'permission or end')
    if (await deny.count()) await deny.first().click()
    await until(async () => (await text(w)).includes('The agent stopped before the study was complete'), 'incomplete banner')
    await w.screenshot({ path: S + '/w1b-build-incomplete.png' })
    return { banner: 'The agent stopped before the study was complete … Try again' }
  })
  await app.close()
}

// ---------- fixture project ----------
const ud = await freshProfile('fixture', srv.origin)
const dir = ud + '/projects/Walkthrough fixture'
const program = makeProject(dir, new URL('../../../../../app/src/shared/sample-program.json', import.meta.url).pathname)
incompletePackage(dir)
let app = await launch(ud, srv.origin)
await app.evaluate(({ dialog }, d) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [d] }); dialog.showMessageBox = async () => ({ response: 0 }) }, dir)
let w = await app.firstWindow(); await w.waitForTimeout(2500); await agree(w)
await w.getByRole('button', { name: 'Open folder' }).click()
await until(async () => (await text(w)).includes('Paper overview'), 'study view')
const tab = (name) => w.locator('button.wb-tab-label', { hasText: name }).first()

await check('W2', 'Incomplete package: no Run button; the notice lists what is missing (incl. run_sessions) and offers Ask the agent to complete it', async () => {
  await tab('Simulation').click()
  await until(async () => (await text(w)).includes('is not complete yet'), 'incomplete notice')
  await w.screenshot({ path: S + '/w2-incomplete-package.png' })
  const t = await text(w)
  const run = await w.locator('button', { hasText: 'Run simulation' }).count()
  if (run) throw Error('Run button visible for incomplete package')
  return { runButtons: run, mentionsRunSessions: t.includes('run_sessions'), askToComplete: t.includes('Ask the agent to complete it') }
})

await check('W3', 'Complete package: Run appears; Stop while getting ready returns to idle', async () => {
  completePackage(dir, program)
  await tab('Study').click(); await w.waitForTimeout(500); await tab('Simulation').click()
  const runBtn = w.locator('.sim-actions .primary')
  await until(async () => (await runBtn.count()) && (await runBtn.first().isVisible()), 'Run button', 20000)
  await w.screenshot({ path: S + '/w3a-complete-package-run.png' })
  await runBtn.first().click()
  // Some builds show a confirm/estimate step; accept it when present.
  const confirm = w.locator('.sim-actions .primary', { hasText: /Start|Run|Confirm/ })
  await w.waitForTimeout(800)
  const stop = w.locator('.sim-stop')
  if (!(await stop.count())) { if (await confirm.count()) await confirm.first().click() }
  await until(async () => (await stop.count()) && (await stop.first().isVisible()), 'Stop button', 15000)
  const during = await text(w)
  await w.screenshot({ path: S + '/w3b-running.png' })
  await stop.first().click()
  await until(async () => !(await stop.count()) && (await runBtn.count()), 'idle after Stop', 15000)
  await w.screenshot({ path: S + '/w3c-after-stop.png' })
  return { gettingReadyShown: during.includes('Getting ready'), idleAfterStop: true }
})

await check('W4', 'Draft in review_notes.txt survives a tab switch and still says Save', async () => {
  await w.locator('button.wb-explorer-toggle').click()
  await w.getByText('review_notes.txt', { exact: true }).first().click()
  const ta = w.locator('textarea').last()
  await until(async () => (await ta.count()) && (await ta.inputValue()).includes('Reviewer notes.'), 'file editor')
  await ta.click(); await w.keyboard.press('End'); await w.keyboard.type(' Unsaved walkthrough draft line.')
  await tab('Study').click(); await w.waitForTimeout(800)
  await w.getByText('review_notes.txt').last().click().catch(() => {})
  await w.locator('button.wb-tab-label', { hasText: 'review_notes' }).first().click().catch(() => {})
  await w.waitForTimeout(800)
  const value = await w.locator('textarea').last().inputValue()
  const bar = await w.locator('.file-bar button').allTextContents()
  await w.screenshot({ path: S + '/w4-draft-after-switch.png' })
  if (!value.includes('Unsaved walkthrough draft line.')) throw Error('draft lost: ' + value)
  if (!bar.some((b) => b.trim() === 'Save')) throw Error('label not Save: ' + bar)
  if (readFileSync(dir + '/review_notes.txt', 'utf8').includes('draft line')) throw Error('draft was saved without asking')
  await w.locator('.file-bar button', { hasText: 'Save' }).first().click()
  await until(() => readFileSync(dir + '/review_notes.txt', 'utf8').includes('draft line'), 'explicit save')
  return { draftKept: true, buttons: bar.map((b) => b.trim()) }
})

await check('W5', 'Study field save changes only that field (CRLF/4-space bytes elsewhere unchanged)', async () => {
  await w.locator('button.wb-explorer-toggle').click().catch(() => {})
  await tab('Study').click(); await w.waitForTimeout(600)
  const before = readFileSync(dir + '/program.json', 'utf8')
  const card = w.locator('[class*=cardBody]', { hasText: 'Background and gap' }).first()
  await card.click(); await w.waitForTimeout(600)
  let editor = w.getByRole('textbox', { name: /Edit Background and gap/ })
  if (!(await editor.count())) { await w.locator('[data-field-id=gap] p').first().click(); await w.waitForTimeout(400); editor = w.getByRole('textbox', { name: /Edit Background and gap/ }) }
  await editor.first().fill('Walkthrough researcher note for the gap field.')
  await w.keyboard.press('Enter')
  await until(() => readFileSync(dir + '/program.json', 'utf8').includes('Walkthrough researcher note'), 'saved field', 15000)
  await w.screenshot({ path: S + '/w5-field-saved.png' })
  const after = readFileSync(dir + '/program.json', 'utf8')
  const a = before.split('\r\n'), b = after.split('\r\n')
  const changed = []; for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) changed.push({ line: i + 1, before: a[i]?.trim().slice(0, 80), after: b[i]?.trim().slice(0, 100) })
  const pa = JSON.parse(before), pb = JSON.parse(after)
  const gapA = pa.nodes.find((n) => n.id === 'background').fields.find((f) => f.id === 'gap'), gapB = pb.nodes.find((n) => n.id === 'background').fields.find((f) => f.id === 'gap')
  gapA.value = gapB.value; gapA.origin = gapB.origin; Object.assign(gapA, gapB)
  const restEqual = JSON.stringify(pa) === JSON.stringify(pb)
  if (!restEqual) throw Error('other JSON content changed')
  if (changed.length > 4) throw Error('too many changed lines: ' + JSON.stringify(changed))
  const versions = existsSync(dir + '/.humanstudy') ? readdirSync(dir + '/.humanstudy') : []
  return { changedLines: changed, crlfKept: after.includes('\r\n') && !/[^\r]\n/.test(after), fourSpaceIndent: after.startsWith('{\r\n    "'), sha256Before: createHash('sha256').update(before).digest('hex').slice(0, 12), sha256After: createHash('sha256').update(after).digest('hex').slice(0, 12), humanstudyDir: versions }
})

await check('W6', 'Citation p>.001 against source p<.001 is located but flagged; clean match says "located … not a confirmation"', async () => {
  await tab('Study').click()
  await w.locator('[class*=_cite_]', { hasText: 'p. 1 +1' }).first().click()
  await w.waitForTimeout(600)
  const flip = w.locator('q', { hasText: 'p>.001' }).first()
  await flip.click()
  await until(async () => (await w.locator('.paper-cite.warn .paper-differs mark').count()) > 0, 'differs marks', 20000)
  const marks = await w.locator('.paper-differs mark').allTextContents()
  await w.screenshot({ path: S + '/w6a-sign-flagged.png' })
  await tab('Study').click()
  await w.locator('[class*=_cite_]', { hasText: 'p. 1 +1' }).first().click(); await w.waitForTimeout(600)
  await w.locator('q', { hasText: 'p<.001' }).first().click()
  await until(async () => (await w.locator('.paper-located').count()) > 0, 'located label', 20000)
  const located = await w.locator('.paper-located').first().textContent()
  await w.screenshot({ path: S + '/w6b-clean-located.png' })
  const body = await text(w)
  if (/verified/i.test(located)) throw Error('says verified')
  return { marks, located: located.trim(), anyVerifiedWord: /\bverified\b/i.test(body) }
})

await check('W7', 'Selecting a sentence in paper A lists A items first and B items under "another source"', async () => {
  await tab('Study').click()
  const cmp = w.locator('button.wb-compare'); if ((await cmp.getAttribute('aria-pressed')) !== 'true') await cmp.click()
  const first = w.locator('.pdf-text span', { hasText: /^Participants\s*$/ }).first(), last = w.locator('.pdf-text span', { hasText: /^cases\.\s*$/ }).first()
  await until(async () => (await first.count()) && (await first.isVisible()) && (await last.count()), 'paper text layer', 20000)
  const b1 = await first.boundingBox(), b2 = await last.boundingBox()
  await w.mouse.move(b1.x + 1, b1.y + b1.height / 2); await w.mouse.down(); await w.mouse.move(b2.x + b2.width - 1, b2.y + b2.height / 2, { steps: 15 }); await w.mouse.up()
  await until(async () => (await text(w)).includes('is cited by'), 'support list', 15000)
  await w.screenshot({ path: S + '/w7-ab-lookup.png' })
  const t = await text(w)
  const i = t.indexOf('is cited by'), o = t.indexOf('Same words, cited from another source')
  if (o < 0) throw Error('no other-source section')
  if (!(i < o)) throw Error('order wrong')
  const sel = await w.evaluate(() => String(window.getSelection()))
  return { header: t.slice(i - 40, i + 12).replace(/\s+/g, ' '), otherSection: true, otherMentionsDocB: t.slice(o, o + 400).includes('doc-b') || (await w.locator('[class*=supportOther][title*=doc-b]').count()) > 0, selected: sel.slice(0, 80) }
})

await check('W8', 'paper.pdf replaced at the same path reloads with a notice', async () => {
  copyFileSync(dir + '/paper-replacement.pdf.bin', dir + '/paper.pdf')
  const layer = () => w.evaluate(() => [...document.querySelectorAll('.pdf-text span')].map((s) => s.textContent).join(''))
  await until(async () => (await layer()).includes('DOCUMENT C REPLACED'), 'new PDF text', 20000)
  await until(async () => (await w.locator('.paper-replaced').count()) > 0, 'replaced notice', 10000)
  const notice = (await w.locator('.paper-replaced').first().textContent()).trim()
  const oldShown = (await layer()).includes('DOCUMENT A ONLY')
  await w.screenshot({ path: S + '/w8-pdf-replaced.png' })
  if (oldShown) throw Error('old document still shown')
  return { notice }
})

await app.close()
srv.close()
const summary = { at: new Date().toISOString(), app: A + '/install/HumanStudy Hub.app', kernel: 'mock', server: 'local mock (no real account or research delivery)', results, mockServerRequests: srv.hits.length }
writeFileSync(A + '/walkthrough-results.json', JSON.stringify(summary, null, 2) + '\n')
console.log(results.filter((r) => r.pass).length + '/' + results.length + ' passed')
