// The OpenCode kernel itself under its minimal macOS profile, with the real HumanStudy kernel binary:
// sessions and shell commands still work (the shell goes through the app's broker into the agent profile),
// while OpenCode's own file and search tools cannot read participant data or other projects.
// Skipped without the binary (HUMANSTUDY_KERNEL_BIN, or the managed install) or without sandbox-exec.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
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
    // The bash tool's form (`<shell> -c <command>`, which the kernel runs) through the shim and the
    // broker: outside the kernel's sandbox, in the agent profile.
    const viaShim = (cmd, shell = s.agentShell.shell, cwd = project) => new Promise(resolve => {
      const c = spawn(shell, ['-c', cmd], { cwd })
      let o = '', e = ''; c.stdout.on('data', d => { o += d }); c.stderr.on('data', d => { e += d })
      c.on('close', code => resolve({ code, o, e }))
    })
    const o1 = await viaShim(`echo shell-ok; echo $HUMANSTUDY_AGENT_SANDBOX; cat human-data/a.csv; cat program.json; curl -s http://127.0.0.1:${net.address().port}/`)
    assert.match(o1.o, /shell-ok\n1\n/)
    assert.match(o1.e, /Operation not permitted/)
    assert.ok(!o1.o.includes('TOPSECRET'))
    assert.match(o1.o, /findme/)
    assert.match(o1.o, /net-ok/)
    // A researcher-approved command runs once outside the sandbox; exit status and stderr come back.
    A.approveCommandOnce(s.agentShell.dir, 'cat human-data/a.csv', project)
    assert.match((await viaShim('cat human-data/a.csv')).o, /TOPSECRET/)
    const again = await viaShim('cat human-data/a.csv')
    assert.ok(!again.o.includes('TOPSECRET') && again.code !== 0 && /not permitted/.test(again.e), 'once')
    assert.equal((await viaShim('exit 7')).code, 7)

    // Review 5 regression: the researcher's own `!` command runs as the researcher (unconfined), through
    // the app, like before the kernel was sandboxed.
    const bang = await k.native(sid, { operation: 'shell', input: { command: 'cat human-data/a.csv; echo ${HUMANSTUDY_AGENT_SANDBOX:-researcher}' } })
    const bangOut = bang.parts?.find(p => p.type === 'tool')?.state?.output ?? JSON.stringify(bang)
    assert.match(bangOut, /TOPSECRET/)
    assert.match(bangOut, /researcher/)
    // The same login-form call without the app having sent it is refused.
    const forged = await k.request(s, 'POST', `/session/${sid}/shell`, { command: 'cat human-data/a.csv', agent: 'build', model: { providerID: 'humanstudy', modelID: 'anthropic/claude-haiku-5.5' } }).then(r => r.json())
    assert.ok(!JSON.stringify(forged).includes('TOPSECRET'))
    assert.match(JSON.stringify(forged), /not allowed/)

    // Review 5 regression: the Terminal view's shell is the researcher's, through a one-use ticket.
    const terminal = (ticket, input) => new Promise(resolve => {
      const c = spawn('/usr/bin/perl', [join(s.agentShell.dir, 'client.pl'), s.broker.socket, '--terminal', ticket], { cwd: project })
      let o = ''; c.stdout.on('data', d => { o += d }); c.stderr.on('data', d => { o += d })
      c.on('close', code => resolve({ code, o }))
      c.stdin.end(input)
    })
    const ticket = s.broker.terminalTicket()
    const t1 = await terminal(ticket, 'cat human-data/a.csv; echo $((6*7)); exit\n')
    assert.match(t1.o, /TOPSECRET/)
    assert.match(t1.o, /42/)
    assert.match((await terminal(ticket, 'echo again; exit\n')).o, /ticket is not valid/)

    // Review 5 M1: another project's broker. B is a second open project.
    const sidB = await k.startSession(other)
    const b = k.sessions.get(sidB).server
    writeFileSync(join(other, 'private.txt'), 'OTHER-PROJECT-CONTENT\n')
    const probe = `perl -MIO::Socket::UNIX -e '$s = IO::Socket::UNIX->new(Peer => shift) or die "connect: $!\\n"; print $s "{}\\n"; print <$s>' ${b.broker.socket}`
    const cross = await viaShim(probe)
    assert.ok(!cross.o.includes('OTHER-PROJECT') && /connect: Operation not permitted/.test(cross.e), cross.o + cross.e)
    // Even a peer that reaches a broker needs that project's secret, a `-c` call and a folder in it.
    const ask = (sock, req) => new Promise(resolve => {
      const c = connect(sock); let buf = Buffer.alloc(0)
      c.on('data', d => { buf = Buffer.concat([buf, d]) }); c.on('close', () => resolve(buf.toString('latin1'))); c.on('error', () => resolve(buf.toString('latin1')))
      c.write(JSON.stringify(req) + '\n')
    })
    const secretB = /my \$secret = '([^']+)'/.exec(readFileSync(join(b.agentShell.dir, 'client.pl'), 'utf8'))[1]
    assert.match(await ask(b.broker.socket, { secret: 'wrong', args: ['-c', 'cat private.txt'], cwd: other }), /not authorised/)
    assert.match(await ask(b.broker.socket, { secret: secretB, args: ['-c', 'cat private.txt'], cwd: project }), /inside the project only/)
    assert.match(await ask(b.broker.socket, { secret: secretB, args: ['-x', 'cat private.txt'], cwd: other }), /not allowed/)
    assert.match(await ask(b.broker.socket, { secret: secretB, args: ['-c', 'cat private.txt'], cwd: other }), /OTHER-PROJECT-CONTENT/)
    // Review 6: the Terminal's window size follows the view ('w' frames to the pseudo-terminal).
    const secretA = /my \$secret = '([^']+)'/.exec(readFileSync(join(s.agentShell.dir, 'client.pl'), 'utf8'))[1]
    const sized = await new Promise(resolve => {
      const c = connect(s.broker.socket); let buf = Buffer.alloc(0)
      c.on('data', d => { buf = Buffer.concat([buf, d]) }); c.on('close', () => resolve(buf.toString('latin1')))
      const f = (t, d) => { const b = Buffer.from(d); const h = Buffer.alloc(5); h.write(t, 0, 'latin1'); h.writeUInt32BE(b.length, 1); return Buffer.concat([h, b]) }
      c.write(JSON.stringify({ secret: secretA, terminal: s.broker.terminalTicket(), rows: 30, cols: 100 }) + '\n')
      // Generous pauses: the login shell starts slowly, and a resize must land between the two reads.
      setTimeout(() => { c.write(f('i', 'stty size\n')) }, 500)
      setTimeout(() => { c.write(f('w', '41 123')) }, 4000)
      setTimeout(() => { c.write(f('i', 'stty size; exit\n')) }, 4500)
    })
    assert.match(sized, /30 100/)
    assert.match(sized, /41 123/)
    // Review 6: under its profile the kernel cannot read another project's broker secret or approval
    // tokens, nor rewrite its agent-shell folder; its own stays readable.
    const underKernel = cmd => spawnSync('/usr/bin/sandbox-exec', ['-f', join(s.agentShell.dir, 'kernel.sb'), '/bin/sh', '-c', cmd], { encoding: 'utf8' })
    assert.notEqual(underKernel(`cat "${join(b.agentShell.dir, 'client.pl')}"`).status, 0)
    assert.notEqual(underKernel(`echo '(allow default)' > "${join(b.agentShell.dir, 'profile.sb')}"`).status, 0)
    assert.notEqual(underKernel(`echo 1 > "${join(b.agentShell.dir, 'approved', 'x')}"`).status, 0)
    assert.equal(underKernel(`head -c 4 "${join(s.agentShell.dir, 'client.pl')}"`).stdout, 'use ')
    assert.match(readFileSync(join(b.agentShell.dir, 'profile.sb'), 'utf8'), /deny file-read-data/)
    // The kernel profile: only its own socket, and no writes to what runs outside it later.
    const profile = readFileSync(join(s.agentShell.dir, 'kernel.sb'), 'utf8')
    assert.match(profile, /\(allow network-outbound \(remote unix-socket \(path-literal/)
    assert.match(profile, /\(deny file-write\* \(subpath "[^"]*agent-shell[^"]*"\)/)
  } finally {
    await k.dispose()
    net.close()
    if (before === undefined) delete process.env.HUMANSTUDY_PROJECTS_ROOT; else process.env.HUMANSTUDY_PROJECTS_ROOT = before
    rmSync(root, { recursive: true, force: true })
  }
})
