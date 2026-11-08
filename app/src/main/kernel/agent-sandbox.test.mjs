// The OS sandbox around the agent's shell (agent-sandbox.ts), run for real on macOS: participant data and
// writes outside the project fail, the network stays open, secrets leave the environment, an approved
// command runs once outside, and the app's confining helpers start outside only while unmodified.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
const out = mkdtempSync(join(tmpdir(), 'agent-sandbox-'))
await build({ entryPoints: [join(here, 'agent-sandbox.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(out, 'a.mjs'), logLevel: 'error' })
const A = await import(pathToFileURL(join(out, 'a.mjs')).href)
process.on('exit', () => rmSync(out, { recursive: true, force: true }))

const mac = process.platform === 'darwin' && A.agentSandboxKind() === 'sandbox-exec'

test('the macOS profile denies participant data in any case and keeps the tool-output exception last', () => {
  const p = A.macosAgentProfile({ project: '/p', kernelHome: '/k', home: '/h', temps: ['/private/tmp'], secretPaths: ['/u/account.json'] })
  assert.match(p, /\(deny file-read-data \(regex #"\/\(\[hH\]\[uU\]\[mM\]\[aA\]\[nN\]-\[dD\]\[aA\]\[tT\]\[aA\]\|/)
  assert.ok(p.indexOf('(allow file-read-data (subpath "/k/data/opencode/tool-output"))') > p.indexOf('(deny file-read-data'))
  assert.match(p, /\(subpath "\/h\/\.ssh"\)/)
  assert.match(p, /\(subpath "\/u\/account\.json"\)/)
  assert.match(p, /\(deny process-info\*\)/)
  // writes: everything denied, then project + temp, then the agent's own configuration and the app's files again
  const w = p.indexOf('(deny file-write*)'), a = p.indexOf('(allow file-write* (subpath "/p")'), d = p.indexOf('(deny file-write* (regex')
  assert.ok(w >= 0 && a > w && d > a)
  assert.match(p.slice(d), /\(subpath "\/p\/\.opencode"\)/)
  assert.ok(!/\(deny network/.test(p), 'network stays open')
})

test('no wrapper without an OS sandbox', () => {
  assert.deepEqual(A.prepareAgentShell({ project: out, kernelHome: join(out, 'k'), kind: 'none' }), { kind: 'none' })
})

test('the Linux wrapper hides participant data with bubblewrap', () => {
  const k = mkdtempSync(join(tmpdir(), 'agent-sandbox-linux-'))
  try {
    const s = A.prepareAgentShell({ project: k, kernelHome: join(k, 'kernel'), kind: 'bwrap', platform: 'linux', realShell: '/bin/bash' })
    const text = readFileSync(s.shell, 'utf8')
    assert.match(text, /-iname 'human-data'/)
    assert.match(text, /--unshare-pid/)
    assert.match(text, /--tmpfs/)
    assert.ok(!/--unshare-net/.test(text), 'network stays open')
    assert.equal(spawnSync('/bin/sh', ['-n', s.shell]).status, 0, 'valid sh')
  } finally { rmSync(k, { recursive: true, force: true }) }
})

test('real sandbox-exec: participant data, writes outside, network, environment, approvals, helpers', { skip: !mac && 'needs macOS sandbox-exec' }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-sandbox-run-')))
  const project = join(root, 'study')
  const kernelHome = join(root, 'kernel')
  const outsideFile = join(homedir(), `.hs-agent-sandbox-test-${process.pid}`)
  const server = createServer((_, res) => res.end('net-ok'))
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  try {
    mkdirSync(join(project, 'human-data'), { recursive: true })
    mkdirSync(join(project, 'Participant-Data'), { recursive: true })
    mkdirSync(join(project, 'sources', 'private'), { recursive: true })
    mkdirSync(join(kernelHome, 'data', 'opencode', 'tool-output'), { recursive: true })
    writeFileSync(join(project, 'human-data', 'a.csv'), 'secret-row\n')
    writeFileSync(join(project, 'Participant-Data', 'p.csv'), 'secret-row\n')
    writeFileSync(join(project, 'sources', 'private', 'si.txt'), 'private-ok\n')
    writeFileSync(join(project, 'program.json'), '{}\n')
    writeFileSync(join(kernelHome, 'data', 'opencode', 'tool-output', 't1'), 'tool-output-ok\n')
    writeFileSync(join(kernelHome, 'data', 'opencode', 'auth.json'), '{"k":"v"}\n')
    const helper = join(project, '.opencode', 'skills', 'simulate', 'run_confined.py')
    mkdirSync(dirname(helper), { recursive: true })
    const py = spawnSync('/bin/sh', ['-c', 'command -v python3']).stdout.toString().trim()
    const helperSrc = 'import ctypes, os\nc = ctypes.CDLL("/usr/lib/libSystem.dylib").sandbox_check\nprint("sandboxed" if c(os.getpid(), None, 0) else "outside")\n'
    writeFileSync(helper, helperSrc)
    A.setTrustedHelperFiles([['.opencode/skills/simulate/run_confined.py', createHash('sha256').update(helperSrc).digest('hex')]])
    const s = A.prepareAgentShell({ project, kernelHome, kind: 'sandbox-exec', realShell: '/bin/bash', runtimeBin: py ? dirname(py) : undefined })
    assert.ok(A.isAgentShell(s.shell))
    const env = { PATH: process.env.PATH, HOME: homedir(), TMPDIR: process.env.TMPDIR ?? '/tmp', OPENCODE_SERVER_PASSWORD: 'pw-should-vanish', OPENCODE_CONFIG_CONTENT: '{"token":"x"}', SOME_API_KEY: 'k-should-vanish', HUMANSTUDY_RELAY_REQUIRED: '1' }
    // Exactly how OpenCode runs a command: <shell> -c <command>, cwd = project.
    // Async, so the local HTTP server in this process can answer the network check.
    const run = (command) => new Promise(resolve => {
      const p = spawn(s.shell, ['-c', command], { cwd: project, env, timeout: 30_000 })
      let o = ''; p.stdout.on('data', d => { o += d }); p.stderr.on('data', d => { o += d })
      p.on('close', code => resolve({ code, out: o }))
    })

    for (const c of ['cat human-data/a.csv', 'cat HUMAN-DATA/a.csv', 'cat Human-Data/../human-data/a.csv', 'cat participant-data/p.csv', 'D=human-data; cat $D/a.csv',
      'cat h*/a.csv', `python3 -c "print(open('hum'+'an-data/a.csv').read())"`, 'cd human-data && cat a.csv', 'ls human-data',
      `cat "${kernelHome}/data/opencode/auth.json"`]) {
      const r = (await run(c))
      assert.ok(!r.out.includes('secret-row') && !r.out.includes('"k"'), `${c} leaked: ${r.out}`)
      assert.notEqual(r.code, 0, c)
    }
    // Ordinary work is untouched: project files, the researcher's private sources, tool output, temp.
    assert.equal((await run('cat program.json')).out.trim(), '{}')
    assert.equal((await run('cat sources/private/si.txt')).out.trim(), 'private-ok')
    assert.equal((await run(`cat "${kernelHome}/data/opencode/tool-output/t1"`)).out.trim(), 'tool-output-ok')
    assert.equal((await run('mkdir -p artifacts && echo ok > artifacts/x.txt && cat artifacts/x.txt')).out.trim(), 'ok')
    assert.equal((await run('f=$(mktemp) && echo tmp-ok > "$f" && cat "$f" && rm "$f"')).out.trim(), 'tmp-ok')
    // Writes outside the project, into the agent's configuration, into participant data: refused.
    for (const c of [`echo x > "${outsideFile}"`, 'echo x > .opencode/skills/simulate/run_confined.py', 'echo x > human-data/b.csv', 'echo "{}" > opencode.json', `echo x > "${kernelHome}/x"`]) {
      assert.notEqual((await run(c)).code, 0, c)
    }
    assert.ok(!existsSync(outsideFile))
    assert.equal(readFileSync(helper, 'utf8'), helperSrc)
    // Network stays open (public source search).
    assert.equal((await run(`curl -s http://127.0.0.1:${server.address().port}/`)).out, 'net-ok')
    // Transport secrets and key-shaped variables are gone; other processes are invisible.
    assert.equal((await run('echo "${OPENCODE_SERVER_PASSWORD:-none} ${OPENCODE_CONFIG_CONTENT:-none} ${SOME_API_KEY:-none} $HUMANSTUDY_AGENT_SANDBOX"')).out.trim(), 'none none none 1')
    assert.notEqual((await run('ps eww -p $PPID')).code, 0)
    // A command the researcher approved runs once outside the sandbox; the next run is confined again.
    A.approveCommandOnce(s.dir, 'cat human-data/a.csv')
    assert.equal((await run('cat human-data/a.csv')).out.trim(), 'secret-row')
    assert.notEqual((await run('cat human-data/a.csv')).code, 0)
    // Expired approvals do not count.
    A.approveCommandOnce(s.dir, 'cat human-data/a.csv', Date.now() - (A.APPROVAL_TTL_S + 5) * 1000)
    assert.notEqual((await run('cat human-data/a.csv')).code, 0)
    if (py) {
      // The app's confining helper starts outside the sandbox as one plain command, while unmodified ...
      assert.equal((await run('python3 .opencode/skills/simulate/run_confined.py')).out.trim(), 'outside')
      // ... but not inside a compound command, and not after a change (here made outside the agent).
      assert.equal((await run('true && python3 .opencode/skills/simulate/run_confined.py')).out.trim(), 'sandboxed')
      writeFileSync(helper, helperSrc + '# changed\n')
      assert.equal((await run('python3 .opencode/skills/simulate/run_confined.py')).out.trim(), 'sandboxed')
    }
  } finally {
    server.close()
    A.setTrustedHelperFiles([])
    rmSync(outsideFile, { force: true })
    rmSync(root, { recursive: true, force: true })
  }
})
