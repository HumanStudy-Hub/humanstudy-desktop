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
await build({ entryPoints: [join(here, 'known-projects.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(out, 'kp.mjs'), logLevel: 'error' })
const K = await import(pathToFileURL(join(out, 'kp.mjs')).href)
const cleanups = []
process.on('exit', () => rmSync(out, { recursive: true, force: true }))

const mac = process.platform === 'darwin' && A.agentSandboxKind() === 'sandbox-exec'

test('the macOS profile denies participant data in any case; the shared tool-output folder has no exception', () => {
  const p = A.macosAgentProfile({ project: '/p', kernelHome: '/k', home: '/h', temps: ['/private/tmp'], secretPaths: ['/u/account.json'] })
  assert.match(p, /\(deny file-read-data \(regex #"\/\(\[hH\]\[uU\]\[mM\]\[aA\]\[nN\]-\[dD\]\[aA\]\[tT\]\[aA\]\|/)
  assert.ok(!p.includes('tool-output'))
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
    spawnSync('git', ['init', '-q', project])
    mkdirSync(join(project, 'sources', 'open'), { recursive: true })
    writeFileSync(join(kernelHome, 'data', 'opencode', 'tool-output', 't1'), 'tool-output-ok\n')
    writeFileSync(join(kernelHome, 'data', 'opencode', 'auth.json'), '{"k":"v"}\n')
    const helper = join(project, '.opencode', 'skills', 'simulate', 'run_confined.py')
    mkdirSync(dirname(helper), { recursive: true })
    const py = spawnSync('/bin/sh', ['-c', 'command -v python3']).stdout.toString().trim()
    const helperSrc = 'import ctypes, os\nc = ctypes.CDLL("/usr/lib/libSystem.dylib").sandbox_check\nprint("sandboxed" if c(os.getpid(), None, 0) else "outside")\n'
    writeFileSync(helper, helperSrc)
    // The probe prints whether it runs inside a sandbox; installed under each helper name it is checked as.
    const helpers = ['simulate/run_confined.py', 'build/recorded_answers.py', 'build/check_validity.py', 'build/audit.py', 'build/check_replies.py', 'build/check_readiness.py', 'export/agent/study_core.py']
    for (const h of helpers) { mkdirSync(dirname(join(project, '.opencode/skills', h)), { recursive: true }); writeFileSync(join(project, '.opencode/skills', h), helperSrc) }
    // effects.py stands in for a helper that runs package code through the real sandbox_run.py: the child
    // (agent-written package code) tries to read participant data and prints what it got.
    const sandboxRun = readFileSync(join(here, '../../../../pack/skills/build/sandbox_run.py'), 'utf8')
    writeFileSync(join(project, '.opencode/skills/build/sandbox_run.py'), sandboxRun)
    writeFileSync(join(project, 'leak.py'), 'try:\n    print("LEAK:" + open("human-data/a.csv").read().strip())\nexcept Exception as e:\n    print("DENIED:" + type(e).__name__)\n')
    const effectsSrc = 'import os, sys\nsys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))\nimport sandbox_run\nfrom pathlib import Path\nwith sandbox_run.work_dir() as w:\n    r = sandbox_run.run_python(Path("leak.py").resolve(), [], cwd=Path(".").resolve(), work=w, timeout=60, read=[Path("human-data").resolve()])\nprint(r.stdout.strip())\n'
    writeFileSync(join(project, '.opencode/skills/build/effects.py'), effectsSrc)
    // prompt_context.py stands in for a helper that opens whatever path a project file names (review 4 #2).
    const readerSrc = 'import json, sys\nfor p in json.load(open("paths.json")):\n    try:\n        print("READ:" + open(p).read().strip())\n    except Exception as e:\n        print("DENIED:" + type(e).__name__)\n'
    writeFileSync(join(project, '.opencode/skills/build/prompt_context.py'), readerSrc)
    const sha = t => createHash('sha256').update(t).digest('hex')
    A.setTrustedHelperFiles([...helpers.map(h => ['.opencode/skills/' + h, sha(helperSrc)]), ['.opencode/skills/build/sandbox_run.py', sha(sandboxRun)], ['.opencode/skills/build/effects.py', sha(effectsSrc)], ['.opencode/skills/build/prompt_context.py', sha(readerSrc)]])
    // Review 7: another project outside the home folder (/Users/Shared), known to the app.
    const shared = existsSync('/Users/Shared') ? mkdtempSync('/Users/Shared/hs-agent-sandbox-') : mkdtempSync(join(root, 'shared-'))
    const projectB = join(shared, 'B')
    mkdirSync(join(projectB, 'sources', 'private'), { recursive: true })
    writeFileSync(join(projectB, 'sources', 'private', 's.txt'), 'PRIVATE-SOURCE-B\n')
    const knownBefore = process.env.HUMANSTUDY_KNOWN_PROJECTS_FILE
    process.env.HUMANSTUDY_KNOWN_PROJECTS_FILE = join(root, 'known-projects.json')
    K.rememberProject(project); K.rememberProject(projectB)
    const s = A.prepareAgentShell({ project, kernelHome, kind: 'sandbox-exec', realShell: '/bin/bash', runtimeBin: py ? dirname(py) : undefined })
    if (knownBefore === undefined) delete process.env.HUMANSTUDY_KNOWN_PROJECTS_FILE; else process.env.HUMANSTUDY_KNOWN_PROJECTS_FILE = knownBefore
    cleanups.push(() => rmSync(shared, { recursive: true, force: true }))
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
    // Review 7: another known project outside the home folder is unreadable and unwritable.
    for (const c of [`cat "${projectB}/sources/private/s.txt"`, `python3 -c "print(open('${projectB}/sources/private/s.txt').read())"`, `ls "${projectB}"`])
      assert.ok(!(await run(c)).out.includes('PRIVATE-SOURCE-B'), c)
    assert.notEqual((await run(`echo x > "${projectB}/planted.txt"`)).code, 0)
    // Review 5: OpenCode's tool-output folder is shared by every project, so the shell cannot read it.
    assert.ok(!(await run(`cat "${kernelHome}/data/opencode/tool-output/t1"`)).out.includes('tool-output-ok'))
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
    A.approveCommandOnce(s.dir, 'cat human-data/a.csv', project)
    assert.equal((await run('cat human-data/a.csv')).out.trim(), 'secret-row')
    assert.notEqual((await run('cat human-data/a.csv')).code, 0)
    // Expired approvals do not count, nor an approval for another folder (review 4: bound to its call).
    A.approveCommandOnce(s.dir, 'cat human-data/a.csv', project, Date.now() - (A.APPROVAL_TTL_S + 5) * 1000)
    assert.notEqual((await run('cat human-data/a.csv')).code, 0)
    const elsewhere = A.approveCommandOnce(s.dir, 'cat */a.csv', join(project, 'sources'))
    assert.ok(!(await run('cat */a.csv')).out.includes('secret-row'), 'approved for sources/, run in the project')
    assert.ok(!existsSync(elsewhere), 'consumed (and refused) by the mismatched call')
    // Review 4 #3: the home folder is unreadable except the project and the runtime; #4: no preference
    // writes (cfprefsd would write them for us).
    const homeFile = join(homedir(), `.hs-agent-sandbox-home-${process.pid}`)
    writeFileSync(homeFile, 'home-secret\n')
    try {
      for (const c of [`cat "${homeFile}"`, `python3 -c "print(open('${homeFile}').read())"`, 'ls ~/Library/Preferences', 'cat ~/.zsh_history ~/.bash_history'])
        assert.ok(!(await run(c)).out.includes('home-secret') && (await run(c)).code !== 0, c)
    } finally { rmSync(homeFile, { force: true }) }
    const domain = `com.humanstudy.sandbox-test-${process.pid}`
    assert.notEqual((await run(`defaults write ${domain} k v`)).code, 0)
    assert.notEqual(spawnSync('defaults', ['read', domain]).status, 0, 'the preference was not written')
    spawnSync('defaults', ['delete', domain])
    // Review 2: no new symlinks (OpenCode's tools would follow them), .git cannot be replaced or written,
    // the search-ignore file cannot be changed; pip's cache and git's safety settings are in place.
    for (const c of ['ln -s .opencode cfg', 'ln -s human-data hd', 'mv .git g2', 'rm -rf .git', 'echo "gitdir: g2" > .git', 'mkdir -p sub/.git', 'echo x > .ignore', 'echo "!human-data" > sources/.ignore'])
      assert.notEqual((await run(c)).code, 0, c)
    assert.ok(!existsSync(join(project, 'cfg')) && existsSync(join(project, '.git', 'config')))
    // Review 3 M1: nothing starts outside the sandbox through LaunchServices or Apple events.
    const marker = join(root, 'pwn-open')
    mkdirSync(join(project, 'Probe.app/Contents/MacOS'), { recursive: true })
    writeFileSync(join(project, 'Probe.app/Contents/Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>p</string><key>CFBundleIdentifier</key><string>hs.agent-sandbox.probe</string></dict></plist>')
    writeFileSync(join(project, 'Probe.app/Contents/MacOS/p'), `#!/bin/sh\ncat "${project}/human-data/a.csv" > "${marker}"\n`, { mode: 0o755 })
    for (const c of ['open -g -j Probe.app', '/usr/bin/open -g Probe.app', 'osascript -e 1', `python3 -c "import subprocess; subprocess.run(['/usr/bin/open', '-g', 'Probe.app'], check=True)"`])
      assert.notEqual((await run(c)).code, 0, c)
    await new Promise(r => setTimeout(r, 1500))
    assert.ok(!existsSync(marker), 'the app bundle never ran')
    assert.equal((await run('echo "$PIP_CACHE_DIR" | grep -c humanstudy-agent-pip; git config core.fsmonitor; git config core.hooksPath')).out.trim(), '1\nfalse\n/dev/null')
    if (py) {
      // The app's confining helper starts outside the sandbox as one plain command, while unmodified ...
      assert.equal((await run('python3 .opencode/skills/build/check_readiness.py .')).out.trim(), 'outside')
      assert.equal((await run('python3 .opencode/skills/build/recorded_answers.py package/p')).out.trim(), 'outside')
      assert.equal((await run('python3 .opencode/skills/simulate/run_confined.py --no-model .opencode/skills/export/agent/study_core.py --root . reproduce')).out.trim(), 'outside')
      assert.equal((await run('python3 .opencode/skills/simulate/run_confined.py artifacts/simulations/r1/run.py --trial')).out.trim(), 'outside', 'relay run')
      // ... never in a child/probe/capture/smoke mode, with another script, toward participant data or
      // the agent's configuration, or without the relay (review 2 M1).
      for (const c of ['python3 .opencode/skills/simulate/run_confined.py --no-model .opencode/skills/export/agent/study_core.py --root reproduce overview',
        'python3 .opencode/skills/simulate/run_confined.py --no-model .opencode/skills/export/agent/study_core.py --root . reproduce overview',
        'python3 .opencode/skills/build/recorded_answers.py --child package/p',
        // Review 5 M3: interpreter flags that would drop the in-process guard.
        'python3 -I .opencode/skills/build/check_readiness.py .', 'python3 -E .opencode/skills/build/check_readiness.py .',
        'python3 -s .opencode/skills/build/check_readiness.py .', 'python3 -S .opencode/skills/build/check_readiness.py .', 'python3 -B .opencode/skills/build/check_readiness.py .', 'python3 .opencode/skills/build/check_validity.py --capture package/p',
        'python3 .opencode/skills/build/check_validity.py --probe package/p', 'python3 .opencode/skills/build/audit.py --probe package/p', 'python3 .opencode/skills/build/audit.py --workdir x .',
        'python3 .opencode/skills/build/check_replies.py --smoke-child package/p', 'python3 .opencode/skills/simulate/run_confined.py --no-model artifacts/x.py',
        'python3 .opencode/skills/simulate/run_confined.py --no-model .opencode/skills/export/agent/study_core.py --root . human-data',
        'python3 .opencode/skills/simulate/run_confined.py --no-model .opencode/skills/export/agent/study_core.py --root . run --cli x',
        'python3 .opencode/skills/build/check_readiness.py ../other', 'python3 .opencode/skills/build/check_readiness.py /tmp', 'python3 .opencode/skills/build/recorded_answers.py human-data',
        'python3 .opencode/skills/build/recorded_answers.py .opencode/plugin', 'python3 .opencode/skills/build/check_readiness.py --no-validity=x/HUMAN-DATA'])
        assert.equal((await run(c)).out.trim(), 'sandboxed', c)
      const noRelay = { ...env }; delete noRelay.HUMANSTUDY_RELAY_REQUIRED
      const r = await new Promise(resolve => { const c = spawn(s.shell, ['-c', 'python3 .opencode/skills/simulate/run_confined.py artifacts/simulations/r1/run.py'], { cwd: project, env: noRelay }); let o = ''; c.stdout.on('data', d => { o += d }); c.on('close', () => resolve(o)) })
      assert.equal(r.trim(), 'sandboxed', 'without the relay run_confined would run the script unconfined')
      // Review 3: `--flag=/abs` and the removed flags fall back to the sandbox.
      for (const c of ['python3 .opencode/skills/build/check_validity.py . --json=/tmp/x.json', 'python3 .opencode/skills/build/audit.py --keep .',
        'python3 .opencode/skills/build/check_readiness.py --no-validity .', 'python3 .opencode/skills/build/check_validity.py . --json=~/x.json'])
        assert.equal((await run(c)).out.trim(), 'sandboxed', c)
      // Review 3 M4: package code started by the agent through a helper cannot read participant data, so
      // the helper's output cannot carry it; the same helper started by the app (no agent flag) can.
      // Review 4 #2: a helper started by the agent cannot open participant data, keys or the home folder
      // outside the project and runtime, whatever path a project file names; started by the app it can.
      const homeSecret = join(homedir(), `.hs-agent-sandbox-guard-${process.pid}`)
      writeFileSync(homeSecret, 'home-secret\n')
      try {
        writeFileSync(join(project, 'paths.json'), JSON.stringify(['human-data/a.csv', 'HUMAN-DATA/../human-data/a.csv', homeSecret, 'program.json']))
        const guarded = (await run('python3 .opencode/skills/build/prompt_context.py .')).out
        assert.equal(guarded.trim().split('\n').join('|'), 'DENIED:PermissionError|DENIED:PermissionError|DENIED:PermissionError|READ:{}', guarded)
        const appRun = spawnSync(py, ['.opencode/skills/build/prompt_context.py', '.'], { cwd: project, env: { PATH: process.env.PATH, HOME: homedir() }, encoding: 'utf8' })
        assert.match(appRun.stdout, /READ:secret-row/)
      } finally { rmSync(homeSecret, { force: true }) }
      const viaAgent = (await run('python3 .opencode/skills/build/effects.py')).out
      assert.match(viaAgent, /DENIED:PermissionError/, viaAgent)
      assert.ok(!viaAgent.includes('secret-row'))
      const byApp = spawnSync(py, ['.opencode/skills/build/effects.py'], { cwd: project, env: { PATH: process.env.PATH, HOME: homedir() }, encoding: 'utf8' })
      assert.match(byApp.stdout, /LEAK:secret-row/, byApp.stdout + byApp.stderr)
      // ... but not inside a compound command, and not after a change (here made outside the agent).
      assert.equal((await run('true && python3 .opencode/skills/simulate/run_confined.py')).out.trim(), 'sandboxed')
      writeFileSync(helper, helperSrc + '# changed\n')
      assert.equal((await run('python3 .opencode/skills/simulate/run_confined.py')).out.trim(), 'sandboxed')
    }
  } finally {
    server.close()
    A.setTrustedHelperFiles([])
    rmSync(outsideFile, { force: true })
    for (const c of cleanups) c()
    rmSync(root, { recursive: true, force: true })
  }
})
