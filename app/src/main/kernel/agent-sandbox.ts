// OS sandbox for the agent's own shell commands (OpenCode's bash tool). Owner rule 2026-11-08: nothing asks
// unless sensitive material is involved, so sensitive material must be protected by something stronger than
// reading the command text (permission-policy.ts is the second layer).
//
// OpenCode runs every bash command as `<shell> -c <command>`, where <shell> is the `shell` of the inline
// config. The app points that at a generated wrapper named like the real shell (zsh/bash, so OpenCode's
// shell handling is unchanged). The wrapper, outside any sandbox:
//   1. drops the kernel's transport secrets and key-shaped variables from the environment;
//   2. runs a command the researcher approved in the conversation (a one-use token the app wrote for that
//      exact command, valid 10 minutes) without the sandbox;
//   3. runs an app helper that confines package code itself (sandbox_run.py: a macOS sandbox cannot be
//      nested) without the sandbox, but only as a plain `python .opencode/skills/...py args` command in the
//      project whose app-owned files still match the shipped hashes;
//   4. runs everything else confined:
//        macOS  sandbox-exec: no reading or writing participant data (human-data, quarantine, withheld,
//               participant-data folders, any case, anywhere), key folders (~/.ssh, ~/.aws, keychains, ...),
//               the app's account/credential files and the kernel's own data (except its tool-output files);
//               no writes outside the project and temp folders, nor to the project's .opencode/,
//               opencode.json or .git/hooks; no access to other processes (their environment holds keys)
//               or to the keychain service. Network stays open (public source search needs it).
//        Linux  bubblewrap with the same file rules where it can express them (see linuxWrapper).
//   Windows (and Linux without bubblewrap) get no wrapper: permission-policy asks before project scripts.
// The wrapper, its profile, the hash list and the approval tokens live in <kernelHome>/agent-shell/, which
// the sandbox cannot write and permission-policy treats as the app's own credentials.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { spawnSync } from 'node:child_process'

export type AgentSandboxKind = 'sandbox-exec' | 'bwrap' | 'none'

/** Folder names that hold participant data. Matched as a whole path segment, in any letter case. */
export const PARTICIPANT_DATA_DIRS = ['human-data', 'quarantine', 'quarantined', 'withheld', 'participant-data', 'participant_data']
/** Credential folders and files under the home folder (read and write denied in the sandbox). */
export const HOME_SECRETS = ['.ssh', '.aws', '.gnupg', '.config/gcloud', '.azure', '.kube', '.docker', 'Library/Keychains',
  '.password-store', '.config/gh', '.claude', '.netrc', '.git-credentials', '.npmrc', '.pypirc', '.humanstudy/credentials']
/** App helpers that run package code through sandbox_run.py and so must start outside the agent sandbox. */
export const CONFINING_HELPERS = ['skills/simulate/run_confined.py', 'skills/build/check_readiness.py', 'skills/build/check_package.py',
  'skills/build/check_replies.py', 'skills/build/check_validity.py', 'skills/build/audit.py', 'skills/build/effects.py',
  'skills/build/recorded_answers.py', 'skills/build/prompt_context.py', 'skills/export/agent_package.py']
/** Environment variables never passed to the agent's commands (the local server password, the inline
 *  config that carries the transport token, the hosted bypass). Key-shaped names go too, see wrapper. */
export const STRIPPED_ENV = ['OPENCODE_SERVER_PASSWORD', 'OPENCODE_CONFIG_CONTENT', 'HUMANSTUDY_SERVER_BYPASS', 'HUMANSTUDY_RELAY_DIR',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']
/** Approval tokens expire: an approved command that never ran must not stay runnable outside the sandbox. */
export const APPROVAL_TTL_S = 600

let trustedFiles: Array<[string, string]> = []
/** Shipped app helper files as [project-relative path, sha256] (main/index.ts registers them from pack.ts;
 *  the kernel module stays free of the bundled pack). Without them no helper runs outside the sandbox. */
export function setTrustedHelperFiles(list: Array<[string, string]>): void { trustedFiles = list }
export const trustedHelperFiles = (): Array<[string, string]> => trustedFiles

const real = (p: string): string => { try { return realpathSync(p) } catch { return p } }
const sq = (s: string): string => "'" + s.replace(/'/g, `'\\''`) + "'"
const sb = (s: string): string => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
/** A regex fragment matching `word` in any letter case (APFS and NTFS are case-insensitive). */
const anyCase = (word: string): string => word.replace(/[A-Za-z]|[^A-Za-z0-9]/g, ch => /[A-Za-z]/.test(ch) ? `[${ch.toLowerCase()}${ch.toUpperCase()}]` : ch === '-' || ch === '_' ? ch : '\\' + ch)
/** SBPL regex: a participant-data folder (or anything in it) anywhere. */
export const PARTICIPANT_REGEX = `/(${PARTICIPANT_DATA_DIRS.map(anyCase).join('|')})(/|$)`

let detected: AgentSandboxKind | undefined
/** Which OS sandbox this computer offers for the agent's shell (checked once, by running it). */
export function agentSandboxKind(platform: string = process.platform): AgentSandboxKind {
  if (process.env.HUMANSTUDY_AGENT_SANDBOX_OFF === '1') return 'none' // developers only; documented
  if (platform === process.platform && detected) return detected
  let kind: AgentSandboxKind = 'none'
  if (platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')) {
    kind = spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], { timeout: 10_000 }).status === 0 ? 'sandbox-exec' : 'none'
  } else if (platform === 'linux') {
    const bw = ['/usr/bin/bwrap', '/bin/bwrap', '/usr/local/bin/bwrap'].find(existsSync)
    if (bw && spawnSync(bw, ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-pid', '/bin/true'], { timeout: 10_000 }).status === 0) kind = 'bwrap'
  }
  if (platform === process.platform) detected = kind
  return kind
}

export interface AgentShellOptions {
  /** The project folder. */
  project: string
  /** The kernel home (<userData>/kernel): wrapper files go to <home>/agent-shell/<project hash>/. */
  kernelHome: string
  /** The app's own credential files and folders (account.json, credentials.json, relays, ...). */
  secretPaths?: string[]
  /** Folder of the managed Python runtime (helpers must run with its python). */
  runtimeBin?: string
  home?: string
  /** The shell OpenCode would have used (default: $SHELL when it is a POSIX shell, else zsh/bash). */
  realShell?: string
  platform?: string
  kind?: AgentSandboxKind
}

export interface AgentShell { kind: AgentSandboxKind; shell?: string; dir?: string }

function pickRealShell(platform: string): string {
  const s = process.env.SHELL?.trim()
  if (s && /^\/.*\/(bash|zsh|sh|dash|ksh)$/.test(s) && existsSync(s)) return s
  return platform === 'darwin' ? '/bin/zsh' : existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh'
}

/** Temp roots the agent may write (real paths; /tmp and /var are links on macOS). */
function tempRoots(platform: string): string[] {
  const roots = new Set<string>([real(tmpdir())])
  if (platform === 'darwin') for (const p of ['/private/tmp', '/private/var/folders', '/private/var/tmp']) roots.add(p)
  else for (const p of ['/tmp', '/var/tmp']) if (existsSync(p)) roots.add(real(p))
  return [...roots]
}

/** The macOS Seatbelt profile for one project. Later rules win, so each allow/deny list is ordered. */
export function macosAgentProfile(o: { project: string; kernelHome: string; secretPaths?: string[]; home?: string; temps?: string[] }): string {
  const project = real(o.project)
  const home = real(o.home ?? homedir())
  const kernel = real(o.kernelHome)
  const secrets = [...HOME_SECRETS.map(d => join(home, d)), kernel, ...(o.secretPaths ?? []).map(real)]
  const temps = o.temps ?? tempRoots('darwin')
  return [
    '(version 1)',
    '(allow default)',
    // Other processes' environment and arguments carry keys (the app, the kernel server): no process info
    // beyond this sandbox, and no keychain service.
    '(deny process-info*)',
    '(allow process-info* (target same-sandbox))',
    '(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd.xpc") (global-name "com.apple.security.agent") (global-name "com.apple.security.authhost"))',
    // Participant data and credentials: contents unreadable (a folder's existence still shows).
    `(deny file-read-data (regex #"${PARTICIPANT_REGEX}") ${secrets.map(p => `(subpath ${sb(p)})`).join(' ')})`,
    `(allow file-read-data (subpath ${sb(join(kernel, 'data', 'opencode', 'tool-output'))}))`,
    // Writes: the project and temp folders only ...
    '(deny file-write*)',
    `(allow file-write* (subpath ${sb(project)}) ${temps.map(t => `(subpath ${sb(t)})`).join(' ')} (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/ptmx") (literal "/dev/dtracehelper") (subpath "/dev/fd") (regex #"^/dev/ttys[0-9]+$"))`,
    // ... except participant data, the agent's own configuration and git hooks (both run code later,
    // outside this sandbox), and the app's files.
    `(deny file-write* (regex #"${PARTICIPANT_REGEX}") (subpath ${sb(join(project, '.opencode'))}) (literal ${sb(join(project, 'opencode.json'))}) (literal ${sb(join(project, 'opencode.jsonc'))}) (subpath ${sb(join(project, '.git', 'hooks'))}) (literal ${sb(join(project, '.git', 'config'))}) ${secrets.map(p => `(subpath ${sb(p)})`).join(' ')})`,
    '',
  ].join('\n')
}

/** Shell code shared by both wrappers: environment, approved commands, app helpers. */
function wrapperHead(o: { dir: string; project: string; realShell: string; runtimeBin?: string; sha: string }): string {
  const entries = CONFINING_HELPERS.map(h => '.opencode/' + h).join(' ')
  return `#!/bin/sh
# HumanStudy agent shell (generated by the app, agent-sandbox.ts; rewritten on every kernel start).
HS_DIR=${sq(o.dir)}
HS_PROJECT=${sq(o.project)}
HS_REAL=${sq(o.realShell)}
HS_RUNTIME=${sq(o.runtimeBin ?? '')}
HS_ENTRIES=${sq(entries)}
unset ${STRIPPED_ENV.join(' ')}
for hs_v in $(env | sed -n 's/^\\([A-Za-z_][A-Za-z0-9_]*\\)=.*/\\1/p' | grep -iE 'KEY|TOKEN|SECRET|PASSW|CREDENTIAL|BYPASS|AUTH'); do
  case "$hs_v" in
    # Pre-relay simulations (Linux, Windows) read the model key from the environment; the run
    # confirmation tells the researcher. With the relay the kernel never has it.
    HUMANSTUDY_DESKTOP_KEY|OPENROUTER_API_KEY) [ "$HUMANSTUDY_RELAY_REQUIRED" = 1 ] && unset "$hs_v" ;;
    *) unset "$hs_v" ;;
  esac
done
unset hs_v
XDG_CACHE_HOME="\${TMPDIR:-/tmp}/humanstudy-agent-cache"; export XDG_CACHE_HOME
MPLCONFIGDIR="\${TMPDIR:-/tmp}/humanstudy-agent-mpl"; export MPLCONFIGDIR

hs_trusted() {
  hs_c=$1
  case "$hs_c" in *[!A-Za-z0-9_./:=,@%+\\ -]*) return 1 ;; esac
  [ "$(pwd -P)" = "$HS_PROJECT" ] || return 1
  set -f; set -- $hs_c; set +f
  case "$1" in python|python3) ;; *) return 1 ;; esac
  hs_py=$(command -v "$1") || return 1
  if [ -n "$HS_RUNTIME" ]; then case "$hs_py" in "$HS_RUNTIME"/*) ;; *) return 1 ;; esac
  else case "$hs_py" in /usr/bin/*|/usr/local/bin/*|/opt/homebrew/bin/*|/Library/Frameworks/*) ;; *) return 1 ;; esac; fi
  shift
  while [ "$#" -gt 0 ]; do case "$1" in -B|-u|-I) shift ;; *) break ;; esac; done
  hs_s=\${1#./}
  case " $HS_ENTRIES " in *" $hs_s "*) ;; *) return 1 ;; esac
  [ -s "$HS_DIR/trusted.sha256" ] || return 1
  ${o.sha} -c --status "$HS_DIR/trusted.sha256" >/dev/null 2>&1
}

if [ "$#" -eq 2 ] && [ "$1" = "-c" ]; then
  hs_h=$(printf '%s' "$2" | ${o.sha} | cut -c1-64)
  hs_t="$HS_DIR/approved/$hs_h"
  if [ -f "$hs_t" ] && mv "$hs_t" "$hs_t.$$" 2>/dev/null; then
    hs_exp=$(cat "$hs_t.$$" 2>/dev/null); rm -f "$hs_t.$$"
    case "$hs_exp" in ''|*[!0-9]*) ;; *) [ "$(date +%s)" -le "$hs_exp" ] && exec "$HS_REAL" -c "$2" ;; esac
  fi
  if hs_trusted "$2"; then exec "$HS_REAL" -c "$2"; fi
fi
HUMANSTUDY_AGENT_SANDBOX=1; export HUMANSTUDY_AGENT_SANDBOX
`
}

function macosWrapper(o: { dir: string; project: string; realShell: string; runtimeBin?: string }): string {
  return wrapperHead({ ...o, sha: 'shasum -a 256' }) + `exec /usr/bin/sandbox-exec -f "$HS_DIR/profile.sb" "$HS_REAL" "$@"\n`
}

/** Linux: bubblewrap. The root is read-only; the project and temp folders are writable; participant-data
 *  folders inside the project (found per command, any case) and credential folders are hidden behind empty
 *  tmpfs mounts (a credential file behind /dev/null); other processes are invisible (own pid namespace).
 *  Unlike macOS, participant data outside the project (other projects) is not hidden. */
function linuxWrapper(o: { dir: string; project: string; realShell: string; runtimeBin?: string; kernelHome: string; secrets: string[]; temps: string[] }): string {
  const bw = ['/usr/bin/bwrap', '/bin/bwrap', '/usr/local/bin/bwrap'].find(existsSync) ?? 'bwrap'
  const names = PARTICIPANT_DATA_DIRS.map(n => `-iname ${sq(n)}`).join(' -o ')
  const toolOutput = join(o.kernelHome, 'data', 'opencode', 'tool-output')
  return wrapperHead({ ...o, sha: 'sha256sum' }) + `HS_NL='
'
hs_hide=''
for hs_p in ${[o.kernelHome, ...o.secrets].map(sq).join(' ')}; do
  if [ -d "$hs_p" ]; then hs_hide="$hs_hide--tmpfs$HS_NL$hs_p$HS_NL"; elif [ -e "$hs_p" ]; then hs_hide="$hs_hide--ro-bind$HS_NL/dev/null$HS_NL$hs_p$HS_NL"; fi
done
[ -d ${sq(toolOutput)} ] && hs_hide="$hs_hide--ro-bind$HS_NL"${sq(toolOutput)}"$HS_NL"${sq(toolOutput)}"$HS_NL"
hs_data=$(find "$HS_PROJECT" -xdev -type d \\( ${names} \\) -prune -print 2>/dev/null)
IFS=$HS_NL; set -f
hs_args="--ro-bind$HS_NL/$HS_NL/$HS_NL--dev$HS_NL/dev$HS_NL--proc$HS_NL/proc$HS_NL--unshare-pid$HS_NL--die-with-parent$HS_NL--bind$HS_NL$HS_PROJECT$HS_NL$HS_PROJECT$HS_NL"
for hs_p in ${o.temps.map(sq).join(' ')}; do [ -d "$hs_p" ] && hs_args="$hs_args--bind$HS_NL$hs_p$HS_NL$hs_p$HS_NL"; done
for hs_p in .opencode opencode.json opencode.jsonc .git/hooks .git/config; do [ -e "$HS_PROJECT/$hs_p" ] && hs_args="$hs_args--ro-bind$HS_NL$HS_PROJECT/$hs_p$HS_NL$HS_PROJECT/$hs_p$HS_NL"; done
for hs_p in $hs_data; do hs_args="$hs_args--tmpfs$HS_NL$hs_p$HS_NL"; done
exec ${sq(bw)} $hs_args$hs_hide "$HS_REAL" "$@"
`
}

/** Write (or rewrite) the wrapper for one project and return the shell path for OpenCode's config. */
export function prepareAgentShell(o: AgentShellOptions): AgentShell {
  const platform = o.platform ?? process.platform
  const kind = o.kind ?? agentSandboxKind(platform)
  if (kind === 'none') return { kind }
  const project = real(o.project)
  const dir = join(o.kernelHome, 'agent-shell', createHash('sha256').update(project).digest('hex').slice(0, 16))
  const realShell = o.realShell ?? pickRealShell(platform)
  const runtimeBin = o.runtimeBin?.replace(/\/+$/, '') // as on PATH (command -v reports it unresolved)
  mkdirSync(join(dir, 'approved'), { recursive: true, mode: 0o700 })
  for (const f of readdirSync(join(dir, 'approved'))) rmSync(join(dir, 'approved', f), { force: true }) // stale tokens
  const trusted = trustedFiles.filter(([rel]) => !rel.includes('\n')).map(([rel, hash]) => `${hash}  ${rel}`).join('\n')
  writeFileSync(join(dir, 'trusted.sha256'), trusted ? trusted + '\n' : '', { mode: 0o600 })
  const temps = tempRoots(platform)
  const shell = join(dir, basename(realShell)) // same name, so OpenCode treats it as that shell
  if (kind === 'sandbox-exec') {
    writeFileSync(join(dir, 'profile.sb'), macosAgentProfile({ project, kernelHome: o.kernelHome, secretPaths: o.secretPaths, home: o.home, temps }), { mode: 0o600 })
    writeFileSync(shell, macosWrapper({ dir, project, realShell, runtimeBin }), { mode: 0o700 })
  } else {
    const home = o.home ?? homedir()
    const secrets = [...HOME_SECRETS.map(d => join(home, d)), ...(o.secretPaths ?? [])]
    writeFileSync(shell, linuxWrapper({ dir, project, realShell, runtimeBin, kernelHome: o.kernelHome, secrets, temps }), { mode: 0o700 })
  }
  return { kind, shell, dir }
}

/** Let one exact command the researcher approved run outside the sandbox (once, within APPROVAL_TTL_S). */
export function approveCommandOnce(dir: string, command: string, now: number = Date.now()): void {
  const h = createHash('sha256').update(command, 'utf8').digest('hex')
  mkdirSync(join(dir, 'approved'), { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, 'approved', h), String(Math.floor(now / 1000) + APPROVAL_TTL_S), { mode: 0o600 })
}

/** For tests and diagnostics: is this file the generated wrapper? */
export const isAgentShell = (p: string): boolean => {
  try { return statSync(p).isFile() && readFileSync(p, 'utf8').startsWith('#!/bin/sh\n# HumanStudy agent shell') } catch { return false }
}
