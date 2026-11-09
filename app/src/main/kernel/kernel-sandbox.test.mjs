// The OpenCode kernel itself under its minimal macOS profile, with the real HumanStudy kernel binary:
// sessions and shell commands still work (the shell goes through the app's broker into the agent profile),
// while OpenCode's own file and search tools cannot read participant data or other projects.
// Skipped without the binary (HUMANSTUDY_KERNEL_BIN, or the managed install) or without sandbox-exec.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
const out = mkdtempSync(join(tmpdir(), 'kernel-sandbox-'))
await build({ entryPoints: [join(here, 'index.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(out, 'k.mjs'), logLevel: 'error' })
await build({ entryPoints: [join(here, 'agent-sandbox.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(out, 'a.mjs'), logLevel: 'error' })
const { OpencodeKernel } = await import(pathToFileURL(join(out, 'k.mjs')).href)
const A = await import(pathToFileURL(join(out, 'a.mjs')).href)
process.on('exit', () => rmSync(out, { recursive: true, force: true }))

const managed = join(homedir(), 'Library/Application Support/HumanStudy Hub/opencode')
const binary = process.env.HUMANSTUDY_KERNEL_BIN || (existsSync(managed) ? readdirSync(managed).sort().reverse().map(v => join(managed, v, 'opencode')).find(existsSync) : undefined)
const skip = process.platform !== 'darwin' ? 'macOS only' : !binary ? 'no HumanStudy kernel binary' : A.agentSandboxKind() !== 'sandbox-exec' ? 'no sandbox-exec' : false

test('the kernel runs sandboxed: tools cannot read participant data or other projects; the shell goes through the broker', { skip }, async () => {
  // Under the home folder, like real projects (the profiles treat the home folder specially).
  const root = realpathSync(mkdtempSync(join(homedir(), '.hs-kernel-sandbox-')))
  const project = join(root, 'projects', 'study'), other = join(root, 'projects', 'other')
  mkdirSync(join(project, 'human-data'), { recursive: true }); mkdirSync(other, { recursive: true })
  writeFileSync(join(project, 'human-data/a.csv'), 'pid,TOPSECRET\n')
  writeFileSync(join(project, 'program.json'), '{"x":"findme"}\n')
  writeFileSync(join(other, 'o.txt'), 'OTHERPROJECT findme\n')
  const net = createServer((_, res) => res.end('net-ok'))
  await new Promise(r => net.listen(0, '127.0.0.1', r))
  const before = process.env.HUMANSTUDY_PROJECTS_ROOT
  process.env.HUMANSTUDY_PROJECTS_ROOT = join(root, 'projects')
  const k = new OpencodeKernel({ binary, provider: '', home: join(root, 'kernel'), readyTimeoutMs: 60_000 })
  try {
    const sid = await k.startSession(project)
    const s = k.sessions.get(sid).server
    assert.equal(s.proc.spawnfile, '/usr/bin/sandbox-exec', 'the kernel starts under its profile')
    assert.ok(s.broker, 'with the shell broker')
    const get = async p => { try { return await (await k.request(s, 'GET', p)).text() } catch (e) { return String(e) } }
    // OpenCode's own tools (HTTP file and search routes use the same code).
    assert.ok(!(await get('/file/content?path=human-data/a.csv')).includes('TOPSECRET'))
    assert.match(await get('/file/content?path=program.json'), /findme/)
    assert.ok(!(await get('/find?pattern=TOPSECRET')).includes('TOPSECRET'))
    assert.ok(!(await get('/file/content?path=' + encodeURIComponent(join(other, 'o.txt')))).includes('OTHERPROJECT'))
    // The shell: started by the app outside the kernel's sandbox, in the agent profile.
    const shell = async command => {
      const r = await k.request(s, 'POST', `/session/${sid}/shell`, { command, agent: 'build', model: { providerID: 'humanstudy', modelID: 'anthropic/claude-haiku-5.5' } })
      const msg = await r.json()
      return msg.parts.find(p => p.type === 'tool')?.state?.output ?? ''
    }
    const o1 = await shell(`echo shell-ok; echo $HUMANSTUDY_AGENT_SANDBOX; cat human-data/a.csv; cat program.json; curl -s http://127.0.0.1:${net.address().port}/`)
    assert.match(o1, /shell-ok\n1\n/)
    assert.match(o1, /Operation not permitted/)
    assert.ok(!o1.includes('TOPSECRET'))
    assert.match(o1, /findme/)
    assert.match(o1, /net-ok/)
    // The bash tool's form (`<shell> -c <command>`) through the shim and broker: a researcher-approved
    // command runs once outside the sandbox; exit status and stderr come back. (The /shell route above is
    // the researcher's own `!` command, which uses OpenCode's login form and stays confined.)
    const viaShim = cmd => new Promise(resolve => {
      const c = spawn(s.agentShell.shell, ['-c', cmd], { cwd: project })
      let o = '', e = ''; c.stdout.on('data', d => { o += d }); c.stderr.on('data', d => { e += d })
      c.on('close', code => resolve({ code, o, e }))
    })
    A.approveCommandOnce(s.agentShell.dir, 'cat human-data/a.csv', project)
    assert.match((await viaShim('cat human-data/a.csv')).o, /TOPSECRET/)
    const again = await viaShim('cat human-data/a.csv')
    assert.ok(!again.o.includes('TOPSECRET') && again.code !== 0 && /not permitted/.test(again.e), 'once')
    assert.equal((await viaShim('exit 7')).code, 7)
  } finally {
    await k.dispose()
    net.close()
    if (before === undefined) delete process.env.HUMANSTUDY_PROJECTS_ROOT; else process.env.HUMANSTUDY_PROJECTS_ROOT = before
    rmSync(root, { recursive: true, force: true })
  }
})
