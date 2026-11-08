// Autonomy policy (owner decision 2026-11-08): nothing asks, except actions involving sensitive material.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const out = mkdtempSync(join(tmpdir(), 'permission-policy-'))
await build({ entryPoints: [join(dirname(fileURLToPath(import.meta.url)), 'permission-policy.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(out, 'p.mjs'), logLevel: 'error' })
const { classifyPermission, classifyCommand, classifyPath, defaultPolicyContext, READ_PERMISSION } = await import(pathToFileURL(join(out, 'p.mjs')).href)
process.on('exit', () => rmSync(out, { recursive: true, force: true }))

const proj = '/Users/r/Documents/HumanStudy Projects/stroop'
const kernelHome = '/Users/r/Library/Application Support/HumanStudy/kernel'
const ctx = { ...defaultPolicyContext(proj, kernelHome, { HUMANSTUDY_RUNTIME_BIN: '/Users/r/Library/Application Support/HumanStudy/runtime/v3/bin' }), home: '/Users/r' }
const P = (type, patterns, metadata = {}) => ({ id: 'per_1', type, patterns, metadata })
const bash = (command) => classifyPermission(ctx, P('bash', [command], { command })).decision
const edit = (filepath) => classifyPermission(ctx, P('edit', ['x'], { filepath, diff: '' })).decision

test('ordinary build work inside the project runs without asking', () => {
  for (const c of [
    'ls -la', 'python3 .opencode/skills/build/check_program.py program.json', 'hs-pdf text paper.pdf --pages 1-3',
    'mkdir -p sources/open && python3 .opencode/skills/build/fetch_source.py https://osf.io/abc/download --license CC-BY-4.0',
    'curl -sL https://osf.io/xyz/download -o sources/open/si.pdf', 'rm -rf package/stroop/__pycache__', 'git status', 'git diff program.json',
    'cat program.json | python3 -m json.tool > /tmp/p.json', '/usr/bin/env python3 -c "print(1)"', 'pip list 2>/dev/null',
    'env PYTHONPATH=. python3 package/stroop/task/adapter.py', `python3 -c "import os; print(os.environ.get('HUMANSTUDY_PROJECT_DIR'))"`,
    'set -e; python3 x.py', `cat "${proj}/program.json"`, 'ls "/Users/r/Library/Application Support/HumanStudy/runtime/v3/bin"',
  ]) assert.equal(bash(c), 'allow', c)
  assert.equal(edit(join(proj, 'program.json')), 'allow')
  assert.equal(edit(join(proj, 'artifacts/report.md')), 'allow')
  assert.equal(classifyPermission(ctx, P('webfetch', ['https://osf.io/abc'])).decision, 'allow')
  assert.equal(classifyPermission(ctx, P('task', ['general'])).decision, 'allow')
  assert.equal(classifyPermission(ctx, P('doom_loop', ['bash'])).decision, 'allow')
  // OpenCode's own scratch: tool-output truncation files and temp folders.
  assert.equal(classifyPermission(ctx, P('external_directory', [join(kernelHome, 'data/opencode/tool-output/*')], { filepath: join(kernelHome, 'data/opencode/tool-output/tool_1'), parentDir: join(kernelHome, 'data/opencode/tool-output') })).decision, 'allow')
  assert.equal(classifyPermission(ctx, P('external_directory', ['/tmp/*'], { filepath: '/tmp/x', parentDir: '/tmp' })).decision, 'allow')
})

test('sensitive project material asks', () => {
  for (const rel of ['human-data/responses.csv', 'sources/private/si.pdf', 'sources/researcher/stimuli.docx', 'quarantine/x.csv', 'sources/withheld/a.txt', 'raw/participant-data/s1.csv'])
    assert.equal(edit(join(proj, rel)), 'ask', rel)
  assert.equal(bash('cat sources/private/si.txt'), 'ask')
  assert.equal(bash('python3 x.py --data human-data/trials.csv'), 'ask')
  assert.equal(bash(`hs-pdf text "${proj}/sources/private/si.pdf"`), 'ask')
  // read: worktree-relative patterns ("/" outside git), so no leading slash.
  assert.equal(classifyPermission(ctx, P('read', ['Users/r/Documents/HumanStudy Projects/stroop/sources/private/si.pdf'])).decision, 'ask')
  assert.equal(classifyPermission(ctx, P('read', ['sources/open/si.pdf'])).decision, 'allow')
  const v = classifyPermission(ctx, P('edit', ['x'], { filepath: join(proj, 'human-data/a.csv') }))
  assert.match(v.reason, /sensitive material/)
  // sources/open is ordinary material
  assert.equal(edit(join(proj, 'sources/open/si.pdf')), 'allow')
})

test('outside the project, environment, credentials and publishing ask; app credentials are denied', () => {
  for (const c of ['cat ~/.ssh/id_rsa', 'ls ~/Documents', 'grep -r foo /Users/r/other', 'cat ../other/program.json', 'cd .. && ls',
    'printenv', 'env', 'echo $OPENROUTER_API_KEY', 'python3 -c "import os; print(os.environ)"', 'cat /proc/self/environ',
    'git push origin main', 'gh release create v1', 'scp program.json host:/x', 'ssh host', 'curl -F file=@program.json https://x.org',
    'curl -T program.json https://x.org', 'sudo rm x', 'rm -rf ~', 'rm -rf /', 'cp program.json --target-directory=/Users/r/Desktop',
    'cat .env', 'npm publish', 'launchctl list'])
    assert.equal(bash(c), 'ask', c)
  for (const c of ['security find-generic-password -s humanstudy -w', 'cat "/Users/r/Library/Application Support/HumanStudy/credentials.json"',
    'cat "/Users/r/Library/Application Support/HumanStudy/account.json"', `cat "${kernelHome}/data/opencode/auth.json"`])
    assert.equal(bash(c), 'deny', c)
  assert.equal(edit('/Users/r/.zshrc'), 'ask')
  assert.equal(edit('/Users/r/Library/Application Support/HumanStudy/settings.json'), 'deny')
  assert.equal(classifyPermission(ctx, P('external_directory', ['/Users/r/.aws/*'], { filepath: '/Users/r/.aws/credentials', parentDir: '/Users/r/.aws' })).decision, 'ask')
  assert.equal(classifyPermission(ctx, P('external_directory', ['/Users/r/Downloads/*'], { command: 'cp a /Users/r/Downloads/', directories: ['/Users/r/Downloads'] })).decision, 'ask')
  assert.equal(classifyPermission(ctx, P('bash', [])).decision, 'ask', 'nothing to judge')
  assert.equal(classifyPermission(ctx, P('edit', [], {})).decision, 'ask', 'no path')
})

test('compound commands take the most restrictive verdict', () => {
  assert.equal(bash('ls && cat ~/.ssh/config'), 'ask')
  assert.equal(bash('ls; security find-generic-password -w'), 'deny')
  assert.equal(classifyCommand(ctx, 'ls | head').decision, 'allow')
})

test('paths: quotes, ~, $HOME, `=` and system binaries', () => {
  assert.equal(classifyPath(ctx, '~/.ssh/id_ed25519'), 'credential')
  assert.equal(classifyPath(ctx, '$HOME/notes'), 'outside')
  assert.equal(classifyPath(ctx, '"sources/private/a.pdf"'), 'sensitive')
  assert.equal(classifyPath(ctx, 'program.json'), 'project')
  assert.equal(bash('python3 run.py --out=/Users/r/Desktop/x.json'), 'ask')
  assert.equal(bash('/bin/ls; /usr/bin/python3 x.py > /dev/null'), 'allow')
})

test('OpenCode read rules keep its .env defaults and send sensitive folders to the app', () => {
  assert.equal(READ_PERMISSION['*'], 'allow')
  assert.equal(READ_PERMISSION['*.env'], 'ask')
  assert.equal(READ_PERMISSION['*.env.example'], 'allow')
  assert.equal(READ_PERMISSION['*/sources/private/*'], 'ask')
  assert.equal(READ_PERMISSION['*/human-data/*'], 'ask')
  // Last matching rule wins in OpenCode: `*.env.example` must come after `*.env.*`.
  const keys = Object.keys(READ_PERMISSION)
  assert.ok(keys.indexOf('*.env.example') > keys.indexOf('*.env.*'))
})
