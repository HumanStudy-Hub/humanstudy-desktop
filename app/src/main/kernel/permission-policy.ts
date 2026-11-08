// Agent autonomy policy (owner decision 2026-11-08: "nothing asks, except actions involving sensitive
// material"). OpenCode routes every edit, every shell command and every path outside the project to the
// app as `permission.asked` (see the inline config in opencode.ts); this module decides each one:
//
//   allow  the app answers "once" by itself (inside the project, the app's scratch dirs, public network)
//   ask    the researcher decides (sensitive material, outside the project, environment, publishing)
//   deny   the app rejects by itself; asking makes no sense (the app's own credentials, the keychain)
//
// This is the second layer. The first is the OS sandbox around the agent's shell (agent-sandbox.ts):
// on macOS (sandbox-exec) and Linux with bubblewrap, participant data, key folders and the app's
// credentials cannot be read by a command the app approved by itself, whatever the command text says.
// Without an OS sandbox (Windows, Linux without bubblewrap) `osSandbox` is false and this module also asks
// before any command that runs code from a file or inline (a script could do anything the text hides).
// A command the researcher approves after an "ask" runs outside the sandbox, once (opencode.ts).
//
// Pattern matching is done here, not in OpenCode's wildcard rules, because a command line needs real
// parsing (quotes, `=`, `~`, `${HOME}`, `cd` chains, globs) that a last-match-wins glob list cannot express.
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { KernelPermission } from './types'
import { PARTICIPANT_DATA_DIRS } from './agent-sandbox'

export type PolicyDecision = 'allow' | 'ask' | 'deny'
export interface PolicyVerdict { decision: PolicyDecision; reason?: string }

export interface PolicyContext {
  /** The project folder (the OpenCode server's directory). */
  dir: string
  /** Folders outside the project the agent may use freely: temp/scratch, the kernel's tool-output files,
   *  the managed runtime. */
  allowedRoots?: string[]
  /** Files or folders that hold app credentials. Never readable or writable by the agent. */
  secretPaths?: string[]
  home?: string
  /** True when the agent's shell runs in an OS sandbox (agent-sandbox.ts). False: ask before running
   *  project scripts or inline code, and before shell paths the text cannot resolve. */
  osSandbox?: boolean
}

/** Project folders whose contents are participant data (PROJECT_FORMAT.md). Matched as a path segment in
 *  any letter case (APFS and NTFS are case-insensitive). sources/private/ and sources/researcher/ are the
 *  researcher's own materials the build needs, and are not asked about. */
export const SENSITIVE_PROJECT_DIRS = PARTICIPANT_DATA_DIRS
const SENSITIVE_NAMES = new Set(PARTICIPANT_DATA_DIRS.map(d => d.toLowerCase()))
/** Credential files anywhere (home or project). */
const SECRET_FILE = /(^|[\\/])(\.env(\.(?!example$)[^\\/]*)?|\.netrc|\.npmrc|\.pypirc|\.git-credentials|id_(rsa|dsa|ecdsa|ed25519)|[^\\/]*\.(pem|p12|pfx))$/i
/** Credential folders under the home folder. */
const SECRET_HOME_DIRS = ['.ssh', '.aws', '.gnupg', '.config/gcloud', '.azure', '.kube', '.docker', 'Library/Keychains', '.password-store', '.config/gh', '.claude']
/** In-project files that configure the agent itself, or run code later outside any sandbox. */
const AGENT_CONFIG = /^(\.opencode([\\/]|$)|opencode\.jsonc?$|\.git[\\/](hooks([\\/]|$)|config$))/i

/** Read-only commands; in "ask" mode these still run without a prompt (the previous allowlist). */
export const READ_ONLY_COMMANDS = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'find', 'pdftotext', 'pdfinfo', 'hs-pdf', 'file', 'pwd', 'echo'])

/** Defaults for the desktop app: temp dirs, the kernel's tool-output files, the managed runtime.
 *  Credentials: the app's account/credential files, run relays, the kernel's config and auth.json, and the
 *  agent shell's own folder (approval tokens). */
export function defaultPolicyContext(dir: string, kernelHome?: string, env: NodeJS.ProcessEnv = process.env, osSandbox = false): PolicyContext {
  const allowedRoots = [tmpdir(), '/tmp', '/private/tmp', '/var/folders', '/private/var/folders']
  const secretPaths: string[] = []
  if (kernelHome) {
    // Only OpenCode's truncated tool output: the rest of its data holds other projects' conversations.
    allowedRoots.push(join(kernelHome, 'data', 'opencode', 'tool-output'))
    secretPaths.push(join(kernelHome, 'data', 'opencode', 'auth.json'), join(kernelHome, 'config'), join(kernelHome, 'agent-shell'))
    // The app sets HUMANSTUDY_KERNEL_HOME to <userData>/kernel.
    if (/[\\/]kernel[\\/]?$/.test(kernelHome)) {
      const userData = dirname(kernelHome.replace(/[\\/]$/, ''))
      secretPaths.push(join(userData, 'account.json'), join(userData, 'credentials.json'), join(userData, 'run-relays'), join(userData, 'settings.json'))
    }
  }
  const runtime = env.HUMANSTUDY_RUNTIME_BIN?.trim()
  if (runtime) allowedRoots.push(dirname(runtime))
  if (env.HUMANSTUDY_RELAY_DIR) secretPaths.push(env.HUMANSTUDY_RELAY_DIR)
  return { dir, allowedRoots, secretPaths, osSandbox }
}

/** Case-insensitive containment (macOS and Windows file systems ignore case). */
const within = (root: string, p: string): boolean => {
  const rel = relative(root.toLowerCase(), p.toLowerCase())
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel))
}
const relTo = (root: string, p: string): string => relative(root.toLowerCase(), p.toLowerCase())

/** secret: the app's own credentials (denied); credential: key files and folders (asked); config: the
 *  agent's own configuration inside the project (editing it asks). */
type Where = 'project' | 'config' | 'sensitive' | 'allowed' | 'outside' | 'credential' | 'secret'

/** Expand `~`, `$HOME` and `${HOME}` at the start of a path. */
function expandHome(p: string, home: string): string {
  if (p === '~' || p.startsWith('~/')) return join(home, p.slice(1))
  const m = /^(\$HOME|\$\{HOME\})(?=\/|$)/.exec(p)
  return m ? join(home, p.slice(m[0].length)) : p
}

/** Where an absolute (or `base`-relative, default project-relative) path falls under the policy. */
export function classifyPath(ctx: PolicyContext, raw: string, base?: string): Where {
  const home = ctx.home ?? homedir()
  const p = expandHome(raw.trim().replace(/^["']|["']$/g, ''), home)
  const abs = isAbsolute(p) ? resolve(p) : resolve(base ?? ctx.dir, p)
  if ((ctx.secretPaths ?? []).some(s => within(s, abs))) return 'secret'
  if (SECRET_HOME_DIRS.some(d => within(join(home, d), abs))) return 'credential'
  if (SECRET_FILE.test(abs)) return 'credential'
  if (isSensitiveRelative(abs)) return 'sensitive' // participant data anywhere (other projects too)
  if (within(ctx.dir, abs)) return AGENT_CONFIG.test(relTo(ctx.dir, abs)) ? 'config' : 'project'
  if ((ctx.allowedRoots ?? []).some(r => within(r, abs))) return 'allowed'
  return 'outside'
}

/** A path (or one of OpenCode's worktree-relative patterns) with a participant-data folder segment. */
export function isSensitiveRelative(rel: string): boolean {
  return rel.split(/[\\/]+/).some(seg => SENSITIVE_NAMES.has(seg.toLowerCase()))
}

const pathVerdict = (where: Where, what: string, writing = false): PolicyVerdict =>
  where === 'secret' ? { decision: 'deny', reason: `the app's own credentials (${what})` }
    : where === 'credential' ? { decision: 'ask', reason: `a key or credential file (${what})` }
    : where === 'sensitive' ? { decision: 'ask', reason: `participant data (${what})` }
      : where === 'outside' ? { decision: 'ask', reason: `outside the project folder (${what})` }
        : where === 'config' && writing ? { decision: 'ask', reason: `changes the agent's own configuration (${what})` }
          : { decision: 'allow' }

const worst = (vs: PolicyVerdict[]): PolicyVerdict =>
  vs.find(v => v.decision === 'deny') ?? vs.find(v => v.decision === 'ask') ?? { decision: 'allow' }

/** System locations a command may name without leaving the project (binaries, devices). */
const SYSTEM_PATH = /^\/(usr|bin|sbin|opt\/homebrew|dev\/(null|stdout|stderr|stdin|tty|fd\/\d+)$|System\/Library|Library\/Frameworks|Applications\/[^/]+\.app\/Contents\/MacOS)/

/** Rules on the command text itself. */
const COMMAND_RULES: Array<[RegExp, PolicyDecision, string]> = [
  [/\bsecurity\s+(find-(generic|internet)-password|dump-keychain|export)\b/, 'deny', 'reads the keychain'],
  [/\$\{?[A-Za-z0-9_]*(KEY|TOKEN|SECRET|PASSW|CREDENTIAL|BYPASS|AUTH)[A-Za-z0-9_]*\}?|\$\{?(OPENCODE_|HUMANSTUDY_RELAY)\w*/i, 'ask', 'reads a credential variable'],
  [/\bos\.environ\b(?!\s*\.get\(\s*["']HUMANSTUDY_(?!DESKTOP_KEY))|\bos\.getenvb?\b|\bprocess\.env\b|\bgetenv\s*\(|\bENV\[|\bSys\.getenv\b/, 'ask', 'reads environment variables'],
  [/\/proc\/[^\s/]+\/environ|\bKERN_PROCARGS/, 'ask', 'reads environment variables'],
  [/\bsudo\b|\bdoas\b/, 'ask', 'runs as administrator'],
  [/\b(osascript|launchctl|crontab|defaults\s+write)\b/, 'ask', 'changes the computer outside the project'],
  [/\brm\s+(-\w+\s+)*(\/|~|\$HOME|\$\{HOME\})\s*($|[;&|])/, 'ask', 'deletes outside the project'],
]

/** One shell word. `expands`: has `$` or a backtick outside single quotes; `glob`: has * ? [ anywhere;
 *  `redirect`: the target of an output redirection (`> file`). */
export interface ShellWord { text: string; expands: boolean; glob: boolean; redirect?: boolean }

/** Simple commands of a command line (split at ; & | ( ) newlines and backticks), as words with quotes
 *  and backslash escapes joined; redirections separate words. Inner `$( ... )` commands become commands
 *  of their own, so their paths are checked too. */
export function parseShell(cmd: string): ShellWord[][] {
  const commands: ShellWord[][] = []
  const inner_: ShellWord[][] = []
  let words: ShellWord[] = []
  let cur = '', q: string | null = null, has = false, expands = false, glob = false, nextRedirect = false
  const endWord = (): void => {
    if (has) { words.push({ text: cur, expands, glob, ...(nextRedirect ? { redirect: true } : {}) }); nextRedirect = false }
    cur = ''; has = false; expands = false; glob = false
  }
  const endCommand = (): void => { endWord(); if (words.length) commands.push(words); words = [] }
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (q === "'") { if (ch === q) q = null; else cur += ch; continue }
    if ((ch === '$' && cmd[i + 1] === '(') || ch === '`') {
      // Command substitution (also inside double quotes): its commands are checked on their own; here it
      // is an unknown value.
      const j = ch === '`' ? cmd.indexOf('`', i + 1) : closingParen(cmd, i + 1)
      const inner = ch === '`' ? cmd.slice(i + 1, j < 0 ? cmd.length : j) : cmd.slice(i + 2, j < 0 ? cmd.length : j)
      inner_.push(...parseShell(inner))
      cur += '$'; has = true; expands = true
      i = j < 0 ? cmd.length : j
      continue
    }
    if (q === '"') {
      if (ch === '"') q = null
      else if (ch === '\\' && i + 1 < cmd.length) cur += cmd[++i]
      else { if (ch === '$' || ch === '`') expands = true; if (ch === '*' || ch === '?' || ch === '[') glob = true; cur += ch }
      continue
    }
    if (ch === "'" || ch === '"') { q = ch; has = true; continue }
    if (ch === '\\' && i + 1 < cmd.length) { cur += cmd[++i]; has = true; continue }
    if (/[;&|()\n]/.test(ch)) { endCommand(); continue }
    if (/[\s<>]/.test(ch)) { endWord(); if (ch === '>') nextRedirect = true; continue }
    if (ch === '$') expands = true
    if (ch === '*' || ch === '?' || ch === '[') glob = true
    cur += ch; has = true
  }
  endCommand()
  return [...commands, ...inner_]
}

/** Index of the `)` closing the `(` at `open` (quotes inside are skipped). -1 when unbalanced. */
function closingParen(cmd: string, open: number): number {
  let depth = 0, q: string | null = null
  for (let i = open; i < cmd.length; i++) {
    const ch = cmd[i]
    if (q) { if (ch === q) q = null; else if (ch === '\\' && q === '"') i++; continue }
    if (ch === "'" || ch === '"') q = ch
    else if (ch === '\\') i++
    else if (ch === '(') depth++
    else if (ch === ')' && --depth === 0) return i
  }
  return -1
}

/** Shell words of a whole command line (compatibility helper). */
export const shellWords = (cmd: string): string[] => parseShell(cmd).flat().map(w => w.text)

/** A glob segment that could expand to a participant-data folder name. A segment of wildcards only (`*`)
 *  matches anything; it counts only when `strict` (no OS sandbox), since `cat` of a bare-star glob reads like `grep -r .`. */
function globHitsSensitive(pattern: string, strict: boolean): boolean {
  return pattern.split(/[\\/]+/).some(seg => {
    if (!/[*?[]/.test(seg)) return false
    if (/^[*?]+$/.test(seg)) return strict
    let re = ''
    for (let i = 0; i < seg.length; i++) {
      const c = seg[i]
      if (c === '*') re += '.*'
      else if (c === '?') re += '.'
      else if (c === '[') { const j = seg.indexOf(']', i + 1); if (j < 0) { re += '\\['; continue } re += '[' + seg.slice(i + 1, j).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']'; i = j }
      else re += c.replace(/[.+^${}()|\\]/g, '\\$&')
    }
    try { const r = new RegExp('^' + re + '$', 'i'); return [...SENSITIVE_NAMES].some(n => r.test(n)) } catch { return true }
  })
}

const INTERPRETERS = /^(python[\d.]*|pypy[\d.]*|node|nodejs|deno|bun|ruby|perl|php|lua|julia|Rscript|R|sh|bash|zsh|dash|ksh|fish|pwsh|powershell|tsx|ts-node|java|osascript|make|source|\.)$/
/** Prefixes that run the command that follows them. */
const WRAPPERS = new Set(['env', 'command', 'exec', 'nohup', 'time', 'nice', 'timeout', 'xargs', 'caffeinate', 'stdbuf'])
const GIT_SENSITIVE_KEY = /^(alias|remote|url|credential|include|includeif|core\.(sshcommand|hookspath|fsmonitor|askpass|gitproxy|editor|pager))(\.|=|$)/i

/** The program a simple command runs (after assignments and wrappers such as `env X=1`), its index. */
function programOf(words: ShellWord[]): number {
  let i = 0
  while (i < words.length) {
    const t = words[i].text
    if (/^[A-Za-z_]\w*=/.test(t)) { i++; continue }
    const base = t.split('/').pop() ?? t
    if (WRAPPERS.has(base)) {
      i++
      while (i < words.length && (words[i].text.startsWith('-') || /^[A-Za-z_]\w*=/.test(words[i].text) || /^\d+[smhd]?$/.test(words[i].text))) {
        i += base === 'env' && /^(-u|--unset|-C|--chdir|-S|--split-string)$/.test(words[i].text) ? 2 : 1 // options with a value
      }
      continue
    }
    return i
  }
  return -1
}

/** Rules that need the words of one simple command (publishing, uploads, environment dumps, scripts). */
function commandVerdicts(ctx: PolicyContext, words: ShellWord[], cmd: string): PolicyVerdict[] {
  const out: PolicyVerdict[] = []
  const ask = (reason: string): void => { out.push({ decision: 'ask', reason: `${reason}: ${cmd.slice(0, 120)}` }) }
  const t = words.map(w => w.text)
  const p0 = programOf(words)
  const first = t[0]?.split('/').pop() ?? ''
  // `env` with no command after it prints the environment (env -0, env -u X).
  if (first === 'env' && p0 < 0) ask('prints environment variables')
  if (p0 < 0) return out
  const prog = (t[p0].split('/').pop() ?? '').replace(/\.exe$/i, '')
  const args = t.slice(p0 + 1)
  const has = (...w: string[]): boolean => args.some(a => w.includes(a))
  switch (prog) {
    case 'printenv': ask('prints environment variables'); break
    case 'set': if (!args.length) ask('prints environment variables'); break
    case 'export': case 'declare': case 'typeset': case 'readonly':
      if (!args.length || args.some(a => /^-\w*[px]/.test(a))) ask('prints environment variables'); break
    case 'compgen': if (args.some(a => /^-\w*[ev]/.test(a) || a === 'variable' || a === 'export')) ask('prints environment variables'); break
    case 'ps': if (args.some(a => (!a.startsWith('-') && /e/.test(a)) || /^-\w*E/.test(a))) ask("prints other processes' environment"); break
    case 'git': {
      // The subcommand: the first word after git's own options (-C dir, -c key=value, --git-dir=...).
      let k = 0
      while (k < args.length && args[k].startsWith('-')) k += /^(-C|-c|--git-dir|--work-tree|--namespace|--exec-path|--config-env)$/.test(args[k]) ? 2 : 1
      const sub = args[k] ?? ''
      if (['push', 'send-email', 'send-pack', 'request-pull', 'credential', 'credential-store', 'credential-cache', 'daemon', 'http-push', 'svn', 'p4'].includes(sub) ||
        (sub === 'remote' && has('add', 'set-url')) ||
        (sub === 'config' && args.some(a => GIT_SENSITIVE_KEY.test(a))) ||
        (sub === 'submodule' && has('foreach')) ||
        args.some((a, i) => (a === '-c' && GIT_SENSITIVE_KEY.test(args[i + 1] ?? '')) || /^-c.+/.test(a) && GIT_SENSITIVE_KEY.test(a.slice(2))) ||
        args.some(a => /^--config-env/.test(a)))
        ask('publishes, or changes git remotes, aliases or credentials')
      break
    }
    case 'gh': if (has('auth', 'release', 'gist', 'api', 'secret', 'ssh-key', 'gpg-key') || (has('repo') && has('create', 'edit', 'fork')) || (has('pr', 'issue') && has('create', 'comment', 'edit'))) ask('publishes with GitHub credentials'); break
    case 'npm': case 'pnpm': case 'yarn': case 'bun': case 'npx':
      if (has('publish', 'adduser', 'login', 'token', 'owner', 'dist-tag', 'deprecate', 'unpublish')) ask('publishes a package'); break
    case 'twine': case 'vercel': case 'netlify': case 'firebase': case 'flyctl': case 'heroku':
      ask('publishes or deploys'); break
    case 'ssh': case 'scp': case 'sftp': case 'nc': case 'ncat': case 'netcat': case 'socat': case 'telnet': case 'ftp': case 'tftp': case 'lftp': case 'smbclient':
      ask('connects to a remote machine'); break
    case 'rsync': if (args.some(a => !a.startsWith('-') && (a.includes(':') || a.startsWith('rsync://'))) || has('-e', '--rsh')) ask('copies to a remote machine'); break
    case 'curl': {
      const upload = args.some((a, i) => {
        const next = args[i + 1] ?? ''
        if (/^(-T|--upload-file)$/.test(a) || /^-T./.test(a) || /^(-K|--config)$/.test(a)) return true
        if (/^(-F|--form|--form-string)$/.test(a)) return /[@<]/.test(next)
        if (/^-F./.test(a)) return /[@<]/.test(a)
        if (/^(-d|--data|--data-binary|--data-raw|--data-urlencode|--data-ascii|--json)$/.test(a)) return next.includes('@')
        if (/^(-d.|--data[\w-]*=|--json=)/.test(a)) return a.includes('@')
        return false
      })
      if (upload) ask('uploads a local file')
      break
    }
    case 'wget': if (args.some(a => /^--(post|body)-file/.test(a))) ask('uploads a local file'); break
  }
  // Without an OS sandbox a script or inline code could read anything; ask before running it. The app's
  // own helpers (.opencode/skills, .opencode/artifact-kit) are exempt: editing them asks.
  if (!ctx.osSandbox) {
    const runsProjectFile = t[p0].includes('/') && !SYSTEM_PATH.test(t[p0]) && !/^\/(usr|bin)\//.test(t[p0])
    if (runsProjectFile) ask('runs a script (no OS sandbox on this computer)')
    else if (INTERPRETERS.test(prog)) {
      const firstArg = args.find(a => !a.startsWith('-')) ?? ''
      const appHelper = /^python[\d.]*$/.test(prog) && !args.some(a => /^-[a-zA-Z]*c/.test(a) || a === '-m') && /^(\.\/)?\.opencode\/(skills|artifact-kit)\/[\w./-]+\.py$/.test(firstArg) && !firstArg.includes('..')
      const harmless = /^python[\d.]*$/.test(prog) && (args[0] === '--version' || (args[0] === '-m' && args[1] === 'json.tool'))
      if (!appHelper && !harmless) ask('runs code (no OS sandbox on this computer)')
    } else if (['pip', 'pip3', 'uv', 'conda'].includes(prog) && has('install', 'run')) ask('installs and runs package code (no OS sandbox on this computer)')
    else if (['npm', 'pnpm', 'yarn', 'npx', 'bunx'].includes(prog) && (prog === 'npx' || prog === 'bunx' || has('run', 'exec', 'test', 'start', 'install', 'ci', 'i'))) ask('runs package scripts (no OS sandbox on this computer)')
    // Writing into the agent's configuration from the shell (the OS sandbox blocks this elsewhere).
    if (words.some(w => w.redirect && AGENT_CONFIG.test(w.text.replace(/^\.\//, ''))) ||
      (!READ_ONLY_COMMANDS.has(prog) && !INTERPRETERS.test(prog) && t.slice(p0 + 1).some(a => !a.startsWith('-') && AGENT_CONFIG.test(a.replace(/^\.\//, ''))))) ask("may change the agent's own configuration")
  }
  return out
}

/** Decide one shell command line. */
export function classifyCommand(ctx: PolicyContext, cmd: string): PolicyVerdict {
  const verdicts: PolicyVerdict[] = []
  for (const [re, decision, reason] of COMMAND_RULES) if (re.test(cmd)) verdicts.push({ decision, reason: `${reason}: ${cmd.slice(0, 120)}` })
  const strict = !ctx.osSandbox
  const vars = new Map<string, string>()
  let base = ctx.dir
  for (const words of parseShell(cmd)) {
    verdicts.push(...commandVerdicts(ctx, words, cmd))
    const p0 = programOf(words)
    const prog = p0 >= 0 ? words[p0].text : ''
    for (const w of words) {
      // Variables assigned in this command line: `D=human-data; cat $D/a.csv`.
      const asg = /^([A-Za-z_]\w*)=(.*)$/.exec(w.text)
      if (asg && !w.expands) vars.set(asg[1], asg[2])
      if (w.text.includes('://')) continue
      for (let piece of w.text.split('=')) {
        piece = piece.replace(/^["'@]+|["',:]+$/g, '')
        if (!piece) continue
        piece = piece.replace(/\$\{?([A-Za-z_]\w*)\}?/g, (m, name: string) => vars.get(name) ?? m)
        const home = /^(~|\$HOME|\$\{HOME\})(\/|$)/.test(piece)
        if (!home && /[$`]/.test(piece) && w.expands) {
          // A path the text cannot resolve (`$X/...`, `$(...)`): the sandbox decides; without one, ask.
          if (/^[$`]/.test(piece) && strict) verdicts.push({ decision: 'ask', reason: `a path built from a shell variable: ${cmd.slice(0, 120)}` })
          continue
        }
        if (w.glob && globHitsSensitive(piece, strict)) { verdicts.push({ decision: 'ask', reason: `a pattern that can match participant data (${piece})` }); continue }
        const pathLike = home || piece.startsWith('/') || piece.startsWith('~') || piece === '..' || piece.startsWith('../') || piece.includes('/') ||
          SECRET_FILE.test(piece) || SENSITIVE_NAMES.has(piece.toLowerCase())
        if (!pathLike) continue
        if (piece.startsWith('/') && SYSTEM_PATH.test(piece)) continue
        const target = piece.replace(/[*?[].*$/, '') || '.'
        const where = classifyPath(ctx, target, base)
        verdicts.push(pathVerdict(where === 'config' ? 'project' : where, piece))
      }
    }
    // `cd X` moves later relative paths: `cd sources && cat ../human-data/a.csv`.
    if (prog === 'cd' || prog === 'pushd') {
      const target = words.slice(p0 + 1).find(w => !w.text.startsWith('-'))
      if (target && !target.expands) base = resolve(base, expandHome(target.text, ctx.home ?? homedir()))
      else if (target && strict) verdicts.push({ decision: 'ask', reason: `changes to a folder the text cannot resolve: ${cmd.slice(0, 120)}` })
      if (!target) base = ctx.home ?? homedir()
    }
  }
  if (base !== ctx.dir) {
    const where = classifyPath(ctx, base)
    if (where !== 'project' && where !== 'config' && where !== 'allowed') verdicts.push(pathVerdict(where, base))
  }
  return worst(verdicts)
}

/** Paths of an edit/read/external_directory request: the absolute metadata path first, since OpenCode's
 *  `patterns` are relative to its worktree root ("/" outside git). */
function requestPaths(perm: KernelPermission): string[] {
  const md = perm.metadata ?? {}
  const list: string[] = []
  for (const k of ['filepath', 'filePath', 'parentDir']) if (typeof md[k] === 'string' && md[k]) list.push(md[k] as string)
  if (Array.isArray(md.directories)) for (const d of md.directories) if (typeof d === 'string') list.push(d)
  if (list.length) return list
  return (perm.patterns ?? []).map(p => p.replace(/[\\/]?\*.*$/, '') || '/')
}

/** The single decision point for an OpenCode permission request. */
export function classifyPermission(ctx: PolicyContext, perm: KernelPermission): PolicyVerdict {
  switch (perm.type) {
    case 'bash': {
      const md = perm.metadata ?? {}
      const cmds = typeof md.command === 'string' && md.command ? [md.command] : perm.patterns ?? []
      if (!cmds.length) return { decision: 'ask', reason: 'unknown command' }
      return worst(cmds.map(c => classifyCommand(ctx, c)))
    }
    case 'edit': case 'write': case 'read': case 'external_directory': case 'list': case 'glob': case 'grep': {
      const writing = perm.type === 'edit' || perm.type === 'write'
      if (perm.type === 'glob' || perm.type === 'grep') {
        // Patterns are search patterns, not paths; only a path in metadata says where it looks.
        const md = perm.metadata ?? {}
        const where = typeof md.path === 'string' ? md.path : undefined
        return where ? pathVerdict(classifyPath(ctx, where), where) : { decision: 'allow' }
      }
      const paths = requestPaths(perm)
      if (!paths.length) return { decision: 'ask', reason: 'unknown path' }
      return worst(paths.map(p => {
        if (isAbsolute(p)) return pathVerdict(classifyPath(ctx, p), p, writing)
        // A worktree-relative pattern: its root is "/" outside git, the repository root inside one. Reads
        // outside the project arrive as external_directory with absolute paths, so here only sensitivity
        // (anywhere in the path) and credential files matter.
        if (isSensitiveRelative(p)) return pathVerdict('sensitive', p)
        const where = classifyPath(ctx, p)
        return pathVerdict(where === 'outside' ? 'project' : where, p, writing)
      }))
    }
    // Public network fetches, subagents, to-do lists, skills: allowed. (doom_loop: opencode.ts caps it.)
    default:
      return { decision: 'allow' }
  }
}

/** A name in OpenCode's case-sensitive wildcard syntax that matches it in any letter case: each letter
 *  becomes `?`, so a few same-shaped names ("sales-data") also reach the app, which decides exactly. */
const anyCaseWildcard = (name: string): string => name.replace(/[A-Za-z]/g, '?')

/** OpenCode `read` rules: reads run without asking except credential files and participant-data folders,
 *  which come to the app (and so to classifyPermission). Last matching rule wins. */
export const READ_PERMISSION: Record<string, 'allow' | 'ask'> = {
  '*': 'allow',
  '*.env': 'ask',
  '*.env.*': 'ask',
  '*.env.example': 'allow',
  ...Object.fromEntries(['human-data', 'participant-data', 'participant_data'].flatMap(d => [d, anyCaseWildcard(d)]).flatMap(d => [[`${d}/*`, 'ask'], [`*/${d}/*`, 'ask']])),
  ...Object.fromEntries(['quarantine', 'quarantined', 'withheld'].flatMap(d => [d, d[0].toUpperCase() + d.slice(1), d.toUpperCase()]).flatMap(d => [[`${d}/*`, 'ask'], [`*/${d}/*`, 'ask']])),
}
