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
import { lstatSync, readdirSync, readlinkSync, realpathSync, type Dirent } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { KernelPermission } from './types'
import { HELPER_FORBIDDEN, PARTICIPANT_DATA_DIRS, searchIgnoreInstalled } from './agent-sandbox'
import { knownProjectsFile, otherProjectRoots } from './known-projects'

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
  /** Real path of `p`, or of its nearest existing parent with the rest appended (tests replace it).
   *  OpenCode's own tools compare paths as text, so a symlink would otherwise carry them anywhere. */
  realpath?: (p: string) => string
  /** Whether the project's .ignore keeps participant data out of grep/glob (agent-sandbox.ts). */
  searchIgnore?: () => boolean
  /** OpenCode's truncated tool output files this project's own calls produced (opencode.ts); any other
   *  file in the shared tool-output folder is another project's, or an approved command's (deleted). */
  toolOutputs?: () => ReadonlySet<string>
  /** Other projects' folders (known-projects.ts): the projects root and every project the app knows. */
  otherProjects?: string[]
  /** The kernel's data folder: every project's conversations (opencode.db), snapshots and tool output. */
  kernelData?: string
  /** Participant-data folders under a search root (tests replace it). */
  findSensitive?: (root: string) => string[]
}

/** Real path of `p`, resolving its nearest existing ancestor (for files about to be created). */
export function realNearest(p: string, depth = 0): string {
  let cur = resolve(p)
  const rest: string[] = []
  for (let i = 0; i < 256; i++) {
    let st
    try { st = lstatSync(cur) } catch { st = undefined }
    if (st) {
      try { return join(realpathSync(cur), ...rest) } catch {
        // A dangling link (its target does not exist yet): follow it by hand.
        if (st.isSymbolicLink() && depth < 32) return join(realNearest(resolve(dirname(cur), readlinkSync(cur)), depth + 1), ...rest)
        return join(cur, ...rest)
      }
    }
    const up = dirname(cur)
    if (up === cur) break
    rest.unshift(basename(cur)); cur = up
  }
  return resolve(p)
}

/** Project folders whose contents are participant data (PROJECT_FORMAT.md). Matched as a path segment in
 *  any letter case (APFS and NTFS are case-insensitive). sources/private/ and sources/researcher/ are the
 *  researcher's own materials the build needs, and are not asked about. */
export const SENSITIVE_PROJECT_DIRS = PARTICIPANT_DATA_DIRS
/** A path segment as the file system compares it: NFKC-normalised, lower case. */
const norm = (seg: string): string => seg.normalize('NFKC').toLowerCase()
const SENSITIVE_NAMES = new Set(PARTICIPANT_DATA_DIRS.map(norm))
/** Credential files anywhere (home or project). */
const SECRET_FILE = /(^|[\\/])(\.env(\.(?!example$)[^\\/]*)?|\.netrc|\.npmrc|\.pypirc|\.git-credentials|id_(rsa|dsa|ecdsa|ed25519)|[^\\/]*\.(pem|p12|pfx))$/i
/** Credential folders under the home folder. */
const SECRET_HOME_DIRS = ['.ssh', '.aws', '.gnupg', '.config/gcloud', '.azure', '.kube', '.docker', 'Library/Keychains', '.password-store', '.config/gh', '.claude']
/** In-project files that configure the agent itself, or run code later outside any sandbox. */
const AGENT_CONFIG = /^(\.opencode([\\/]|$)|opencode\.jsonc?$|\.git([\\/]|$))|(^|[\\/])(\.git([\\/]|$)|\.(rg)?ignore$)/i

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
    // (OpenCode's tool-output folder is shared by every project: only this project's files are allowed,
    // see toolOutputs.)
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
  // The list of known projects decides what every sandbox profile denies.
  const known = knownProjectsFile()
  if (known) secretPaths.push(known, known + '.tmp')
  return { dir, allowedRoots, secretPaths, osSandbox, searchIgnore: () => searchIgnoreInstalled(dir), otherProjects: otherProjectRoots(dir), ...(kernelHome ? { kernelData: join(kernelHome, 'data') } : {}) }
}

/** Case-insensitive containment (macOS and Windows file systems ignore case). */
const within = (root: string, p: string): boolean => {
  const rel = relative(root.toLowerCase(), p.toLowerCase())
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel))
}
const relTo = (root: string, p: string): string => relative(root.toLowerCase(), p.toLowerCase())

/** secret: the app's own credentials (denied); credential: key files and folders (asked); config: the
 *  agent's own configuration inside the project (editing it asks). */
type Where = 'project' | 'config' | 'sensitive' | 'allowed' | 'outside' | 'credential' | 'secret' | 'conversations' | 'other-project'

/** Expand `~`, `$HOME` and `${HOME}` at the start of a path. */
function expandHome(p: string, home: string): string {
  if (p === '~' || p.startsWith('~/')) return join(home, p.slice(1))
  const m = /^(\$HOME|\$\{HOME\})(?=\/|$)/.exec(p)
  return m ? join(home, p.slice(m[0].length)) : p
}

const RANK: Record<Where, number> = { project: 0, allowed: 1, config: 2, outside: 3, conversations: 3.5, 'other-project': 3.6, sensitive: 4, credential: 5, secret: 6 }

function classifyAbs(ctx: PolicyContext, abs: string, real: (p: string) => string): Where {
  const home = ctx.home ?? homedir()
  const roots = (r: string): string[] => { const x = real(r); return x === r ? [r] : [r, x] }
  const inside = (r: string): boolean => roots(r).some(x => within(x, abs))
  if ((ctx.secretPaths ?? []).some(inside)) return 'secret'
  if (SECRET_HOME_DIRS.some(d => inside(join(home, d)))) return 'credential'
  if (SECRET_FILE.test(abs)) return 'credential'
  if (isSensitiveRelative(abs)) return 'sensitive' // participant data anywhere (other projects too)
  const dir = roots(ctx.dir).find(x => within(x, abs))
  if (dir !== undefined) return AGENT_CONFIG.test(relTo(dir, abs)) ? 'config' : 'project'
  if ((ctx.otherProjects ?? []).some(inside)) return 'other-project'
  // The kernel's data first (it may sit under an allowed temp folder): this project's own tool output only.
  if (ctx.toolOutputs?.().has(abs)) return 'allowed'
  if (ctx.kernelData && inside(ctx.kernelData)) return 'conversations'
  if ((ctx.allowedRoots ?? []).some(inside)) return 'allowed'
  return 'outside'
}

/** Where an absolute (or `base`-relative, default project-relative) path falls under the policy: the
 *  stricter of the path as written and its real path (symlinks resolved, nearest existing parent for a
 *  file about to be created). */
export function classifyPath(ctx: PolicyContext, raw: string, base?: string): Where {
  const home = ctx.home ?? homedir()
  const p = expandHome(raw.trim().replace(/^["']|["']$/g, ''), home)
  const abs = isAbsolute(p) ? resolve(p) : resolve(base ?? ctx.dir, p)
  const real = ctx.realpath ?? realNearest
  const a = classifyAbs(ctx, abs, real)
  let r: Where = a
  try { const ra = real(abs); if (ra !== abs) r = classifyAbs(ctx, ra, real) } catch { /* keep the text verdict */ }
  return RANK[r] > RANK[a] ? r : a
}

/** A path (or one of OpenCode's worktree-relative patterns) with a participant-data folder segment. */
export function isSensitiveRelative(rel: string): boolean {
  return rel.split(/[\\/]+/).some(seg => SENSITIVE_NAMES.has(norm(seg)))
}

const pathVerdict = (where: Where, what: string, writing = false): PolicyVerdict =>
  where === 'secret' ? { decision: 'deny', reason: `the app's own credentials (${what})` }
    : where === 'credential' ? { decision: 'ask', reason: `a key or credential file (${what})` }
    : where === 'sensitive' ? { decision: 'ask', reason: `participant data (${what})` }
      : where === 'outside' ? { decision: 'ask', reason: `outside the project folder (${what})` }
      : where === 'other-project' ? { decision: 'ask', reason: `another project (${what})` }
      : where === 'conversations' ? { decision: 'ask', reason: `another project's conversations, snapshots or tool output, kept by the app's agent (${what})` }
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
    if (ch === '*' || ch === '?' || ch === '[' || ch === '{') glob = true
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
  return expandBraces(pattern).some(p => isSensitiveRelative(p) || globHitsSensitiveOne(p, strict))
}

/** `{a,b}` alternatives of a glob (nested too), at most 256; an unbalanced brace keeps the text. */
export function expandBraces(p: string, depth = 0): string[] {
  const open = p.indexOf('{')
  if (open < 0 || depth > 8) return [p]
  let level = 0, close = -1
  const parts: string[] = []
  let start = open + 1
  for (let i = open; i < p.length; i++) {
    if (p[i] === '{') level++
    else if (p[i] === '}' && --level === 0) { close = i; break }
    else if (p[i] === ',' && level === 1) { parts.push(p.slice(start, i)); start = i + 1 }
  }
  if (close < 0) return [p.replace('{', '')]
  parts.push(p.slice(start, close))
  const out: string[] = []
  for (const alt of parts) for (const x of expandBraces(p.slice(0, open) + alt + p.slice(close + 1), depth + 1)) { out.push(x); if (out.length >= 256) return out }
  return out
}

function globHitsSensitiveOne(pattern: string, strict: boolean): boolean {
  return pattern.split(/[\\/]+/).some(seg => {
    if (!/[*?[]/.test(seg)) return false
    if (/^[*?]+$/.test(seg)) return strict
    let re = ''
    for (let i = 0; i < seg.length; i++) {
      const c = seg[i]
      if (c === '*') re += '.*'
      else if (c === '?') re += '.'
      // A character class only narrows a match: any one character (never copied into a JS class). The
      // first `]` after `[` (or `[!`) is part of the class, as in globset; unbalanced counts as reaching.
      else if (c === '[') { const j = seg.indexOf(']', i + (seg[i + 1] === '!' || seg[i + 1] === '^' ? 3 : 2)); if (j < 0) return true; re += '.'; i = j }
      else re += c.replace(/[.+^${}()|\\]/g, '\\$&')
    }
    try { const r = new RegExp('^' + re + '$', 'i'); return [...SENSITIVE_NAMES].some(n => r.test(n)) } catch { return true }
  })
}

/** Participant-data folders under `root` (paths relative to it), at most 8 levels deep. */
export function findSensitiveDirs(root: string): string[] {
  const out: string[] = []
  let seen = 0
  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > 8 || seen > 20000 || out.length > 64) return
    let entries: Dirent[]
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      seen++
      if (!e.isDirectory() || e.name === 'node_modules' || e.name === '.git') continue
      const r = rel ? rel + '/' + e.name : e.name
      if (SENSITIVE_NAMES.has(norm(e.name))) out.push(r)
      else walk(join(dir, e.name), r, depth + 1)
    }
  }
  walk(root, '', 0)
  return out
}

/** A ripgrep --glob as a regular expression over a slash-separated relative path (gitignore rules: no
 *  slash matches the basename at any depth; `**`; character classes; `{a,b}` alternatives). */
export function ripgrepGlobRegex(glob: string): RegExp | null {
  let g = glob.replace(/^\//, '')
  const anchoredPath = g.includes('/')
  let re = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*' && g[i + 1] === '*') {
      if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2 } else { re += '.*'; i += 1 }
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    // Any class is "any one character" (a class only narrows; globset's class syntax is not copied).
    else if (c === '[') { const j = g.indexOf(']', i + (g[i + 1] === '!' || g[i + 1] === '^' ? 3 : 2)); if (j < 0) return null; re += '[^/]'; i = j }
    else if (c === '{') re += '(?:'
    else if (c === '}') re += ')'
    else if (c === ',') re += '|'
    else if (c === '\\' && i + 1 < g.length) re += g[++i].replace(/[.+^$(){}|[\]\\*?]/g, '\\$&')
    else re += c.replace(/[.+^$()|\\]/g, '\\$&')
  }
  try { return new RegExp((anchoredPath ? '^' : '^(?:.*/)?') + re + '/?$', 'i') } catch { return null }
}

/** Whether a ripgrep --glob could whitelist a participant-data folder under `root` (and so override the
 *  project's .ignore). Exclusions (`!…`) never do; a glob that cannot be parsed counts as reaching. */
export function globReachesSensitive(glob: string, root: string, find: (root: string) => string[] = findSensitiveDirs): boolean {
  if (glob.startsWith('!')) return false
  const dirs = find(root)
  if (!dirs.length) return false
  const re = ripgrepGlobRegex(glob)
  return !re || dirs.some(d => re.test(d))
}

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

/** App helpers that only read the project (and PDFs) and never run project code: allowed without an OS
 *  sandbox, with arguments that stay relative, inside the project and away from participant data and the
 *  agent's configuration. The helpers that run package code (agent-sandbox CONFINING_HELPERS) are not here:
 *  without an OS sandbox sandbox_run.py cannot confine that code. */
export const READ_ONLY_HELPERS = ['skills/build/check_program.py', 'skills/build/check_quotes.py', 'skills/build/check_results.py',
  'skills/build/check_verbatim.py', 'skills/build/sources.py', 'skills/build/qsf_flow.py', 'skills/build/check_materials.py',
  'skills/build/estimate_run.py', 'skills/build/paper_tables.py', 'skills/build/check_source_use.py', 'skills/build/docx_text.py',
  'skills/build/capabilities.py', 'skills/build/program_io.py']

/** One argument of an allowlisted command: plain text, relative, inside the project, not participant data
 *  or a key file; `writes`: the command may write there, so not the agent's configuration either. */
function plainArg(w: ShellWord, writes = false): boolean {
  const a = w.text
  if (w.expands || w.redirect || /^[/~\\]|^[A-Za-z]:|(^|[\\/])\.\.([\\/]|$)/.test(a)) return false
  if (w.glob && globHitsSensitive(a, true)) return false
  const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : a
  if (isSensitiveRelative(v) || SECRET_FILE.test(v)) return false
  return !writes || (!AGENT_CONFIG.test(v.replace(/^\.\//, '')) && !HELPER_FORBIDDEN.some(f => norm(a).includes(f)))
}

/** The allowlist for computers without an OS sandbox: ls, cat/head/tail/wc/file/pwd/echo, grep, find without
 *  actions, pdf text, git status/diff/log/show, and the read-only app helpers; every argument plain. */
function strictAllowed(words: ShellWord[]): boolean {
  const t = words.map(w => w.text)
  if (!t.length) return true
  if (words.some(w => w.redirect && !/^\/dev\/null$|^\d$/.test(w.text))) return false
  const prog = t[0]
  const args = words.slice(1)
  const plain = (ws: ShellWord[]): boolean => ws.every(w => plainArg(w))
  switch (prog) {
    case 'ls': case 'cat': case 'head': case 'tail': case 'wc': case 'file': case 'pwd': case 'echo': case 'pdfinfo': case 'sort': case 'uniq': case 'cut': case 'true':
      return plain(args)
    case 'pdftotext': case 'hs-pdf': return args.every(w => plainArg(w, true))
    // Recursive grep reads every folder (grep ignores .ignore): only file-level searches run without asking.
    case 'grep': return plain(args) && !args.some(w => /^--(include|exclude)-from|^-f$|^--file|^--recursive|^--dereference-recursive|^-d$|^--directories/.test(w.text) || /^-[A-Za-z]*[rR]/.test(w.text))
    case 'find': return plain(args) && !args.some(w => /^-(exec|execdir|ok|okdir|delete|fprint\w*|fls)$/.test(w.text))
    case 'git': {
      const sub = args[0]?.text ?? ''
      return ['status', 'diff', 'log', 'show'].includes(sub) && plain(args) && !args.some(w => /^--(ext-diff|output|textconv)|^-c$|^-C$/.test(w.text))
    }
    case 'python': case 'python3': {
      const script = (args[0]?.text ?? '').replace(/^\.\//, '')
      return READ_ONLY_HELPERS.some(h => script === '.opencode/' + h) && args.slice(1).every(w => plainArg(w, true))
    }
    default: return false
  }
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
  // Without an OS sandbox only an allowlist of read-only commands runs without asking (strictAllowed).
  if (!ctx.osSandbox && !strictAllowed(words)) ask('only read-only commands run without asking on a computer without an OS sandbox')
  return out
}

/** Decide one shell command line. */
export function classifyCommand(ctx: PolicyContext, cmd: string, start?: string): PolicyVerdict {
  const verdicts: PolicyVerdict[] = []
  for (const [re, decision, reason] of COMMAND_RULES) if (re.test(cmd)) verdicts.push({ decision, reason: `${reason}: ${cmd.slice(0, 120)}` })
  const strict = !ctx.osSandbox
  const vars = new Map<string, string>()
  let base = start ?? ctx.dir
  for (const words of parseShell(cmd)) {
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
          SECRET_FILE.test(piece) || SENSITIVE_NAMES.has(norm(piece))
        if (!pathLike) continue
        if (piece.startsWith('/') && SYSTEM_PATH.test(piece)) continue
        const target = piece.replace(/[*?[].*$/, '') || '.'
        const where = classifyPath(ctx, target, base)
        verdicts.push(pathVerdict(where === 'config' ? 'project' : where, piece))
      }
    }
    verdicts.push(...commandVerdicts(ctx, words, cmd)) // after the paths: their reasons are more specific
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

/** Paths of an edit/read/list/lsp/external_directory request: the absolute metadata path first, since
 *  OpenCode's `patterns` are relative to its worktree root ("/" outside git, else the repository root). */
function requestPaths(perm: KernelPermission): string[] {
  const md = perm.metadata ?? {}
  const list: string[] = []
  // apply_patch: one request for several files, `filepath` is their names joined by ", " (never a path).
  // Every file and every move target is checked, and every pattern.
  if (Array.isArray(md.files)) {
    for (const f of md.files as Array<Record<string, unknown>>) for (const k of ['filePath', 'movePath']) if (f && typeof f[k] === 'string' && f[k]) list.push(f[k] as string)
    return [...list, ...(perm.patterns ?? [])]
  }
  if ((perm.patterns?.length ?? 0) > 1) return [...perm.patterns!]
  for (const k of ['filepath', 'filePath', 'path']) if (typeof md[k] === 'string' && md[k]) list.push(md[k] as string)
  // parentDir only when no file is named (it is the file's folder, e.g. the shared tool-output folder).
  if (!list.length && typeof md.parentDir === 'string' && md.parentDir) list.push(md.parentDir)
  if (Array.isArray(md.directories)) for (const d of md.directories) if (typeof d === 'string') list.push(d)
  if (list.length) return list
  return (perm.patterns ?? []).filter(p => !/^mcp:/.test(p)).map(p => p.replace(/[\\/]?\*.*$/, '') || '/')
}

/** A worktree-relative pattern names "/<p>" outside git, or <repository root>/<p> inside one: classify every
 *  reading that exists on disk (through symlinks); when none does, the text alone. */
function relativeVerdict(ctx: PolicyContext, p: string, writing: boolean): PolicyVerdict {
  if (isSensitiveRelative(p)) return pathVerdict('sensitive', p)
  const exists = (x: string): boolean => { try { lstatSync(x); return true } catch { return false } }
  // OpenCode's worktree: the nearest folder with a .git, else "/" (also with a .git that has no commit
  // yet, which the policy cannot tell apart): every existing reading counts, the strictest wins.
  let root = '/'
  for (let up = resolve(ctx.dir), i = 0; i < 128; i++) {
    if (exists(join(up, '.git'))) { root = up; break }
    if (dirname(up) === up) break
    up = dirname(up)
  }
  const found = [...new Set([join(root, p), join('/', p)])].filter(exists)
  if (found.length) return worst(found.map(c => pathVerdict(classifyPath(ctx, c), p, writing)))
  const where = classifyPath(ctx, p)
  // Nothing exists yet: the "/" reading still counts when it names the kernel's data or credentials.
  const fromRoot = classifyPath(ctx, join('/', p))
  if (['conversations', 'secret', 'credential', 'sensitive'].includes(fromRoot)) return pathVerdict(fromRoot, p, writing)
  return pathVerdict(where === 'outside' ? 'project' : where, p, writing)
}

/** The single decision point for an OpenCode permission request. Every request type reaches the app
 *  (PERMISSION_CONFIG `"*": "ask"` in opencode.ts); unknown types without a path are allowed. */
export function classifyPermission(ctx: PolicyContext, perm: KernelPermission): PolicyVerdict {
  const md = perm.metadata ?? {}
  switch (perm.type) {
    case 'bash': {
      const cmds = typeof md.command === 'string' && md.command ? [md.command] : perm.patterns ?? []
      if (!cmds.length) return { decision: 'ask', reason: 'unknown command' }
      // The tool's `workdir` (from the tool call's input, opencode.ts): relative paths start there.
      const wd = typeof md.workdir === 'string' && md.workdir ? md.workdir : undefined
      const base = wd ? resolve(ctx.dir, expandHome(wd, ctx.home ?? homedir())) : undefined
      const wv = wd ? pathVerdict(classifyPath(ctx, wd), wd) : { decision: 'allow' as const }
      return worst([wv, ...cmds.map(c => classifyCommand(ctx, c, base))])
    }
    case 'glob': case 'grep': {
      // Where it searches: metadata.path (absolute or project-relative), else the project. Participant data
      // under it is skipped by ripgrep through the project's .ignore (agent-sandbox.ts); if that block is
      // missing, a search over the project asks. Outside the project only OpenCode's tool output is searched
      // freely (temp folders can hold copies of a study).
      const where = typeof md.path === 'string' && md.path ? md.path : ctx.dir
      const at = classifyPath(ctx, where)
      const v = pathVerdict(at, where)
      if (v.decision !== 'allow') return v
      const toolOutput = ctx.toolOutputs?.().has(resolve(where)) ?? false
      if (at === 'allowed' && !toolOutput) return { decision: 'ask', reason: `a search outside the project (${where})` }
      // ripgrep gets `include` (grep) or `pattern` (glob) as --glob, and a matching --glob overrides .ignore:
      // ask when it could match a participant-data folder that exists under the search root.
      const root = resolve(ctx.dir, expandHome(where, ctx.home ?? homedir()))
      for (const k of perm.type === 'glob' ? ['pattern'] : ['include', 'pattern']) {
        const g = typeof md[k] === 'string' ? md[k] as string : ''
        if (!g) continue
        if (isSensitiveRelative(g) || globHitsSensitive(g, false)) return { decision: 'ask', reason: `a search pattern aimed at participant data (${g})` }
        if ((perm.type === 'glob' || k === 'include') && globReachesSensitive(g, root, ctx.findSensitive))
          return { decision: 'ask', reason: `a search filter that would include participant data (${g})` }
      }
      if (at === 'project' && !(ctx.searchIgnore?.() ?? false)) return { decision: 'ask', reason: `a search that can reach participant data (the project's .ignore is missing its HumanStudy block)` }
      return { decision: 'allow' }
    }
    case 'edit': case 'write': case 'read': case 'external_directory': case 'list': case 'lsp': {
      const writing = perm.type === 'edit' || perm.type === 'write'
      const paths = requestPaths(perm)
      if (!paths.length) return perm.type === 'lsp' ? { decision: 'allow' } : { decision: 'ask', reason: 'unknown path' }
      return worst(paths.map(p => isAbsolute(p) ? pathVerdict(classifyPath(ctx, p), p, writing) : relativeVerdict(ctx, p, writing)))
    }
    // Public network fetches, subagents, to-do lists, skills: allowed. (doom_loop: opencode.ts caps it.)
    default:
      return { decision: 'allow' }
  }
}
