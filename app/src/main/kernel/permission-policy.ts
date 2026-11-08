// Agent autonomy policy (owner decision 2026-11-08: "nothing asks, except actions involving sensitive
// material"). OpenCode routes every edit, every shell command and every path outside the project to the
// app as `permission.asked` (see the inline config in opencode.ts); this module decides each one:
//
//   allow  the app answers "once" by itself (inside the project, the app's scratch dirs, public network)
//   ask    the researcher decides (sensitive material, outside the project, environment, publishing)
//   deny   the app rejects by itself; asking makes no sense (the app's own credentials, the keychain)
//
// Pattern matching is done here, not in OpenCode's wildcard rules, because a command line needs real
// parsing (paths after `=`, `~`, `..`, upload flags) that a last-match-wins glob list cannot express.
// The package-code sandbox (build/sandbox_run.py, the per-run model relay) is a separate, unchanged layer.
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { KernelPermission } from './types'

export type PolicyDecision = 'allow' | 'ask' | 'deny'
export interface PolicyVerdict { decision: PolicyDecision; reason?: string }

export interface PolicyContext {
  /** The project folder (the OpenCode server's directory). */
  dir: string
  /** Folders outside the project the agent may use freely: temp/scratch, the kernel's own data
   *  (tool-output truncation files), the managed runtime. */
  allowedRoots?: string[]
  /** Files or folders that hold app credentials. Never readable or writable by the agent. */
  secretPaths?: string[]
  home?: string
}

/** Project-relative folders whose contents are sensitive (PROJECT_FORMAT.md): participant data
 *  (human-data/), licence-restricted or researcher-supplied materials (sources/private/,
 *  sources/researcher/), and anything quarantined or withheld. */
export const SENSITIVE_PROJECT_DIRS = ['human-data', 'sources/private', 'sources/researcher']
const SENSITIVE_SEGMENT = /(^|[\\/])(quarantine|quarantined|withheld|participant[-_]data)([\\/]|$)/i
/** Credential files anywhere (home or project). */
const SECRET_FILE = /(^|[\\/])(\.env(\.(?!example$)[^\\/]*)?|\.netrc|\.npmrc|\.pypirc|\.git-credentials|id_(rsa|dsa|ecdsa|ed25519)|[^\\/]*\.(pem|p12|pfx))$/i
/** Credential folders under the home folder. */
const SECRET_HOME_DIRS = ['.ssh', '.aws', '.gnupg', '.config/gcloud', '.azure', '.kube', '.docker', 'Library/Keychains', '.password-store', '.config/gh', '.claude']

/** Read-only commands; in "ask" mode these still run without a prompt (the previous allowlist). */
export const READ_ONLY_COMMANDS = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'find', 'pdftotext', 'pdfinfo', 'hs-pdf', 'file', 'pwd', 'echo'])

/** Defaults for the desktop app: temp dirs, the kernel home (userData/kernel: tool-output files), the
 *  managed runtime. Credentials: the app's account/credential files, run relays and the kernel's auth.json. */
export function defaultPolicyContext(dir: string, kernelHome?: string, env: NodeJS.ProcessEnv = process.env): PolicyContext {
  const allowedRoots = [tmpdir(), '/tmp', '/private/tmp', '/var/folders', '/private/var/folders']
  const secretPaths: string[] = []
  if (kernelHome) {
    allowedRoots.push(join(kernelHome, 'data'), join(kernelHome, 'cache'), join(kernelHome, 'state'))
    secretPaths.push(join(kernelHome, 'data', 'opencode', 'auth.json'), join(kernelHome, 'config'))
    // The app sets HUMANSTUDY_KERNEL_HOME to <userData>/kernel.
    if (/[\\/]kernel[\\/]?$/.test(kernelHome)) {
      const userData = dirname(kernelHome.replace(/[\\/]$/, ''))
      secretPaths.push(join(userData, 'account.json'), join(userData, 'credentials.json'), join(userData, 'run-relays'), join(userData, 'settings.json'))
    }
  }
  const runtime = env.HUMANSTUDY_RUNTIME_BIN?.trim()
  if (runtime) allowedRoots.push(dirname(runtime))
  if (env.HUMANSTUDY_RELAY_DIR) secretPaths.push(env.HUMANSTUDY_RELAY_DIR)
  return { dir, allowedRoots, secretPaths }
}

const within = (root: string, p: string): boolean => {
  const rel = relative(root, p)
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel))
}

/** secret: the app's own credentials (denied); credential: key files and folders (asked). */
type Where = 'project' | 'sensitive' | 'allowed' | 'outside' | 'credential' | 'secret'

/** Where an absolute (or project-relative) path falls under the policy. */
export function classifyPath(ctx: PolicyContext, raw: string): Where {
  const home = ctx.home ?? homedir()
  let p = raw.trim().replace(/^["']|["']$/g, '')
  if (p === '~' || p.startsWith('~/')) p = join(home, p.slice(1))
  else if (p.startsWith('$HOME')) p = join(home, p.slice(5))
  const abs = isAbsolute(p) ? resolve(p) : resolve(ctx.dir, p)
  if ((ctx.secretPaths ?? []).some(s => within(s, abs))) return 'secret'
  if (SECRET_HOME_DIRS.some(d => within(join(home, d), abs))) return 'credential'
  if (SECRET_FILE.test(abs)) return 'credential'
  if (within(ctx.dir, abs)) return isSensitiveRelative(relative(ctx.dir, abs)) ? 'sensitive' : 'project'
  if ((ctx.allowedRoots ?? []).some(r => within(r, abs))) return 'allowed'
  return 'outside'
}

/** A project-relative path (or one of OpenCode's worktree-relative patterns) in a sensitive folder. */
export function isSensitiveRelative(rel: string): boolean {
  const r = '/' + rel.split(sep).join('/').replace(/^\/+/, '')
  return SENSITIVE_PROJECT_DIRS.some(d => r.includes('/' + d + '/') || r.endsWith('/' + d)) || SENSITIVE_SEGMENT.test(r)
}

const pathVerdict = (where: Where, what: string): PolicyVerdict =>
  where === 'secret' ? { decision: 'deny', reason: `the app's own credentials (${what})` }
    : where === 'credential' ? { decision: 'ask', reason: `a key or credential file (${what})` }
    : where === 'sensitive' ? { decision: 'ask', reason: `sensitive material (${what})` }
      : where === 'outside' ? { decision: 'ask', reason: `outside the project folder (${what})` }
        : { decision: 'allow' }

const worst = (vs: PolicyVerdict[]): PolicyVerdict =>
  vs.find(v => v.decision === 'deny') ?? vs.find(v => v.decision === 'ask') ?? { decision: 'allow' }

/** System locations a command may name without leaving the project (binaries, devices). */
const SYSTEM_PATH = /^\/(usr|bin|sbin|opt\/homebrew|dev\/(null|stdout|stderr|stdin|tty|fd\/\d+)$|System\/Library|Library\/Frameworks|Applications\/[^/]+\.app\/Contents\/MacOS)/

/** Rules on the command text itself, before its path arguments. */
const COMMAND_RULES: Array<[RegExp, PolicyDecision, string]> = [
  [/\bsecurity\s+(find-(generic|internet)-password|dump-keychain|export)\b/, 'deny', 'reads the keychain'],
  [/(^|[;&|(]\s*)(printenv|env|set|export\s+-p|declare\s+-x|compgen\s+-e)\s*($|[;&|)>])/, 'ask', 'prints environment variables'],
  [/(^|[;&|(]\s*)printenv\b/, 'ask', 'reads environment variables'],
  [/\$\{?[A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|BYPASS)[A-Z0-9_]*\}?/, 'ask', 'reads a credential variable'],
  [/\bos\.environ\b(?!\s*\.get\(\s*["']HUMANSTUDY_(?!DESKTOP_KEY))|\bprocess\.env\b|\bgetenv\s*\(|\bENV\[/, 'ask', 'reads environment variables'],
  [/\/proc\/[^\s/]+\/environ/, 'ask', 'reads environment variables'],
  [/\bgit\s+(push|remote\s+(add|set-url)|send-email|credential)\b/, 'ask', 'publishes or touches git credentials'],
  [/\bgh\s+(auth|repo\s+create|release|pr\s+create|gist)\b/, 'ask', 'publishes with GitHub credentials'],
  [/\b(npm|pnpm|yarn)\s+publish\b|\btwine\s+upload\b|\bvercel\b.*\b(deploy|--prod)\b/, 'ask', 'publishes a package'],
  [/\b(ssh|scp|sftp|rsync\s+[^\n]*\S+:)\b/, 'ask', 'connects to a remote machine'],
  [/\bcurl\b[^\n]*(\s-(T|F|d|-data[\w-]*|-upload-file|-form)\b[^\n]*@|\s(-T|--upload-file)\s)/, 'ask', 'uploads a local file'],
  [/\bwget\b[^\n]*--post-file/, 'ask', 'uploads a local file'],
  [/\bsudo\b|\bdoas\b/, 'ask', 'runs as administrator'],
  [/\b(osascript|launchctl|crontab|defaults\s+write)\b/, 'ask', 'changes the computer outside the project'],
  [/\brm\s+(-\w+\s+)*(\/|~|\$HOME)\s*($|[;&|])/, 'ask', 'deletes outside the project'],
]

/** Shell words: quotes and backslash escapes joined, operators and redirections as separators. */
export function shellWords(cmd: string): string[] {
  const words: string[] = []
  let cur = '', q: string | null = null, has = false
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (q) {
      if (ch === q) q = null
      else if (ch === '\\' && q === '"' && i + 1 < cmd.length) cur += cmd[++i]
      else cur += ch
      continue
    }
    if (ch === "'" || ch === '"') { q = ch; has = true; continue }
    if (ch === '\\' && i + 1 < cmd.length) { cur += cmd[++i]; has = true; continue }
    if (/[\s;&|()<>]/.test(ch)) { if (has) words.push(cur); cur = ''; has = false; continue }
    cur += ch; has = true
  }
  if (has) words.push(cur)
  return words
}

/** Path-like tokens of one shell command line (after `=`, without quotes and redirection marks). A quoted
 *  word with spaces that is not itself a path (inline code: `python3 -c "..."`) is searched for paths too. */
function pathTokens(cmd: string): string[] {
  const out: string[] = []
  const words = shellWords(cmd).flatMap(w => /\s/.test(w) && !/^(\/|~|\$HOME)/.test(w) ? [w, ...w.split(/[\s;&|()<>,]+/)] : [w])
  for (const raw of words) {
    if (!raw || raw.includes('://')) continue
    for (const piece of raw.split('=')) {
      const t = piece.replace(/^["'@]+|["',]+$/g, '')
      if (!t || t.includes('://')) continue
      if (t.startsWith('/') || t.startsWith('~') || t.startsWith('$HOME') || t === '..' || t.startsWith('../') || t.includes('/../') ||
        /^(\.\/)?[\w.-]+\//.test(t) || SECRET_FILE.test(t)) out.push(t)
    }
  }
  return out
}

/** Decide one shell command line. */
export function classifyCommand(ctx: PolicyContext, cmd: string): PolicyVerdict {
  const verdicts: PolicyVerdict[] = []
  for (const [re, decision, reason] of COMMAND_RULES) if (re.test(cmd)) verdicts.push({ decision, reason: `${reason}: ${cmd.slice(0, 120)}` })
  for (const t of pathTokens(cmd)) {
    if (t.startsWith('/') && SYSTEM_PATH.test(t)) continue
    const base = t.replace(/[*?].*$/, '') || '.'
    verdicts.push(pathVerdict(classifyPath(ctx, base), t))
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
      if (perm.type === 'glob' || perm.type === 'grep') {
        // Patterns are search patterns, not paths; only a path in metadata says where it looks.
        const md = perm.metadata ?? {}
        const where = typeof md.path === 'string' ? md.path : undefined
        return where ? pathVerdict(classifyPath(ctx, where), where) : { decision: 'allow' }
      }
      const paths = requestPaths(perm)
      if (!paths.length) return { decision: 'ask', reason: 'unknown path' }
      return worst(paths.map(p => {
        if (isAbsolute(p)) return pathVerdict(classifyPath(ctx, p), p)
        // A worktree-relative pattern: its root is "/" outside git, the repository root inside one. Reads
        // outside the project arrive as external_directory with absolute paths, so here only sensitivity
        // (anywhere in the path) and credential files matter.
        if (isSensitiveRelative(p)) return pathVerdict('sensitive', p)
        const where = classifyPath(ctx, p)
        return pathVerdict(where === 'outside' ? 'project' : where, p)
      }))
    }
    // Public network fetches, subagents, to-do lists, skills: allowed.
    default:
      return { decision: 'allow' }
  }
}

/** OpenCode `read` rules: reads run without asking except credential files and sensitive project
 *  folders, which come to the app (and so to classifyPermission). Last matching rule wins. */
export const READ_PERMISSION: Record<string, 'allow' | 'ask'> = {
  '*': 'allow',
  '*.env': 'ask',
  '*.env.*': 'ask',
  '*.env.example': 'allow',
  ...Object.fromEntries(SENSITIVE_PROJECT_DIRS.flatMap(d => [[`${d}/*`, 'ask'], [`*/${d}/*`, 'ask']])),
  '*quarantine*': 'ask',
  '*withheld*': 'ask',
  '*participant-data*': 'ask',
  '*participant_data*': 'ask',
}
