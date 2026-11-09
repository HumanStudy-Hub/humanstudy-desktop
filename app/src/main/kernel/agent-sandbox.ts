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
//               the app's account/credential files and the kernel's own data (tool output included);
//               no writes outside the project and temp folders, nor to the project's .opencode/,
//               opencode.json or .git/hooks; no access to other processes (their environment holds keys)
//               or to the keychain service. Network stays open (public source search needs it).
//        Linux  bubblewrap with the same file rules where it can express them (see linuxWrapper).
//   Windows (and Linux without bubblewrap) get no wrapper: permission-policy asks before project scripts.
// The wrapper, its profile, the hash list and the approval tokens live in <kernelHome>/agent-shell/, which
// the sandbox cannot write and permission-policy treats as the app's own credentials.
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

export type AgentSandboxKind = 'sandbox-exec' | 'bwrap' | 'none'

/** Folder names that hold participant data. Matched as a whole path segment, in any letter case. */
export const PARTICIPANT_DATA_DIRS = ['human-data', 'human_data', 'quarantine', 'quarantined', 'withheld', 'participant-data', 'participant_data']
/** Credential folders and files under the home folder (read and write denied in the sandbox). */
export const HOME_SECRETS = ['.ssh', '.aws', '.gnupg', '.config/gcloud', '.azure', '.kube', '.docker', 'Library/Keychains',
  '.password-store', '.config/gh', '.claude', '.netrc', '.git-credentials', '.npmrc', '.pypirc', '.humanstudy/credentials']
/** App helpers that run package code through sandbox_run.py and so must start outside the agent sandbox. */
export const CONFINING_HELPERS = ['skills/simulate/run_confined.py', 'skills/build/check_readiness.py', 'skills/build/check_package.py',
  'skills/build/check_replies.py', 'skills/build/check_validity.py', 'skills/build/audit.py', 'skills/build/effects.py',
  'skills/build/recorded_answers.py', 'skills/build/prompt_context.py', 'skills/export/agent_package.py']
/** Per helper: the flags allowed on the unsandboxed path (agent-sandbox wrapper) and the help text for
 *  docs. Internal child modes that import or run project code in-process are never allowed there:
 *  recorded_answers.py --child, check_validity.py --capture/--probe, audit.py --probe/--n,
 *  check_replies.py --smoke-child, check_package.py/agent_package.py --smoke-test, audit.py --workdir.
 *  run_confined.py runs a simulation only through the relay (HUMANSTUDY_RELAY_REQUIRED=1, which needs the
 *  researcher's Run approval), and `--no-model` only with the shipped study_core.py `reproduce`. */
export const HELPER_FLAGS: Record<string, string[]> = {
  'check_readiness.py': [],
  'check_package.py': ['--no-validity', '--program'],
  'check_replies.py': ['--package'],
  'check_validity.py': ['--package', '--json'],
  'audit.py': ['--out', '--book', '--online', '--no-run', '--no-export', '--only', '--timeout'],
  'effects.py': [],
  'recorded_answers.py': [],
  'prompt_context.py': [],
  'agent_package.py': ['--output', '--root', '--mcp', '--include-paper', '--include-sources'],
  'study_core.py': ['--root', '--method'],
}
/** Words an argument of an unsandboxed helper may never contain (lower case): the agent's configuration,
 *  git, search-ignore files and participant data. */
export const HELPER_FORBIDDEN = ['.opencode', '.git', 'opencode.json', '.ignore', '.rgignore', 'human-data', 'human_data', 'quarantine', 'withheld', 'participant']

/** Environment variables never passed to the agent's commands (the local server password, the inline
 *  config that carries the transport token, the hosted bypass). Key-shaped names go too, see wrapper. */
export const STRIPPED_ENV = ['HUMANSTUDY_AGENT_RUN', 'OPENCODE_SERVER_PASSWORD', 'OPENCODE_CONFIG_CONTENT', 'HUMANSTUDY_SERVER_BYPASS', 'HUMANSTUDY_RELAY_DIR',
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
  /** The app's shell broker socket (shell-broker.ts): OpenCode's shell becomes a client of it, so commands
   *  start outside the kernel's own sandbox and inside the agent profile. Without it the wrapper is the shell. */
  socket?: string
  /** Per-launch secret the broker requires (written only into this project's client.pl). */
  secret?: string
}

export interface AgentShell { kind: AgentSandboxKind; shell?: string; dir?: string; /** the wrapper the broker runs */ inner?: string }

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
export function macosAgentProfile(o: { project: string; kernelHome: string; secretPaths?: string[]; home?: string; temps?: string[]; runtimeBin?: string; socket?: string }): string {
  const project = real(o.project)
  const home = real(o.home ?? homedir())
  const kernel = real(o.kernelHome)
  const secrets = [...HOME_SECRETS.map(d => join(home, d)), kernel, ...(o.secretPaths ?? []).map(real)]
  const temps = o.temps ?? tempRoots('darwin')
  // What the shell may read in the home folder: the project, the managed runtime, git's own settings.
  // Never the home folder itself or one of its parents (that would undo the rule).
  const homeReads = [project, ...(o.runtimeBin ? [runtimeRoot(o.runtimeBin)] : []), join(home, '.gitconfig'), join(home, '.config', 'git')]
    .filter(p => p !== '/' && !within(p, home))
  return [
    '(version 1)',
    '(allow default)',
    // Other processes' environment and arguments carry keys (the app, the kernel server): no process info
    // beyond this sandbox, and no keychain service.
    '(deny process-info*)',
    '(allow process-info* (target same-sandbox))',
    '(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd.xpc") (global-name "com.apple.security.agent") (global-name "com.apple.security.authhost"))',
    // Nothing starts outside this sandbox: LaunchServices (`open`, app bundles) and Apple events (scripting
    // Terminal, Finder) would run code unconfined. Spotlight queries (mdfind) would reveal what other
    // folders contain.
    '(deny lsopen)',
    '(deny appleevent-send)',
    '(deny process-exec (literal "/usr/bin/open") (literal "/usr/bin/osascript") (literal "/usr/bin/osacompile") (literal "/usr/bin/automator") (literal "/usr/bin/shortcuts"))',
    '(deny mach-lookup (global-name-regex #"^com\\.apple\\.metadata\\.mds"))',
    // No other app's preferences (cfprefsd writes them on the caller's behalf: a Terminal start command
    // would run unconfined later), and no clipboard (it often holds passwords).
    '(deny user-preference-write)',
    '(deny mach-lookup (global-name "com.apple.cfprefsd.agent") (global-name "com.apple.cfprefsd.daemon") (global-name "com.apple.pasteboard.1"))',
    // Nothing in the home folder is readable but the project, the managed runtime and git's settings:
    // shell history, other projects, other apps' tokens stay out of reach.
    `(deny file-read-data (subpath ${sb(home)}))`,
    `(allow file-read-data ${homeReads.map(p => `(subpath ${sb(p)})`).join(' ')})`,
    // Participant data and credentials: contents unreadable (a folder's existence still shows).
    `(deny file-read-data (regex #"${PARTICIPANT_REGEX}") ${secrets.map(p => `(subpath ${sb(p)})`).join(' ')})`,
    // (No exception for OpenCode's tool-output folder: it is shared by all projects and can hold the output
    // of a command the researcher approved. The read tool reaches this project's files through the policy.)
    // The app's shell brokers (every project's) serve their kernels, never the commands they start.
    ...(o.socket ? [`(deny network-outbound (remote unix-socket (subpath ${sb(dirname(o.socket))})))`] : []),
    // Writes: the project and temp folders only ...
    '(deny file-write*)',
    `(allow file-write* (subpath ${sb(project)}) ${temps.map(t => `(subpath ${sb(t)})`).join(' ')} (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/ptmx") (literal "/dev/dtracehelper") (subpath "/dev/fd") (regex #"^/dev/ttys[0-9]+$"))`,
    // ... except participant data, the agent's own configuration, any .git (its config and hooks run code
    // later, outside this sandbox; replacing .git with a `gitdir:` file is a write to that path too), the
    // search-ignore files that keep participant data out of OpenCode's grep/glob, and the app's files.
    `(deny file-write* (regex #"${PARTICIPANT_REGEX}") (regex #"/\\.[gG][iI][tT](/|$)") (regex #"/\\.([rR][gG])?[iI][gG][nN][oO][rR][eE]$") (subpath ${sb(join(project, '.opencode'))}) (literal ${sb(join(project, 'opencode.json'))}) (literal ${sb(join(project, 'opencode.jsonc'))}) ${secrets.map(p => `(subpath ${sb(p)})`).join(' ')})`,
    // No new symbolic links: OpenCode's own tools compare paths as text, so a link would carry them into
    // .opencode/ or participant data. (Hard links to denied files fail: the source is not writable.)
    '(deny file-write-create (vnode-type SYMLINK))',
    '',
  ].join('\n')
}

/** The managed runtime's root folder (…/runtime) from its bin folder. */
export function runtimeRoot(bin: string): string {
  let cur = real(bin)
  for (let i = 0; i < 4; i++) { if (basename(cur) === 'runtime') return cur; cur = dirname(cur) }
  return real(bin) // not the managed layout: just its bin folder
}

/** The minimal profile the OpenCode kernel process itself runs under (macOS). It only takes away what the
 *  kernel never needs, so every OpenCode tool (read, grep, glob, apply_patch, lsp, ...) is confined at the
 *  root whatever its path checks miss: participant data, key folders, the app's credential files, other
 *  projects, preference writes, LaunchServices. Its shell commands run outside it, through the app's
 *  broker (shell-broker.ts), in the stricter agent profile. */
export function macosKernelProfile(o: { project: string; kernelHome?: string; home?: string; secretPaths?: string[]; projectsRoots?: string[]; socket?: string; agentShellDir?: string }): string {
  const project = real(o.project)
  const home = real(o.home ?? homedir())
  // Projects folders (other projects live there); never the home folder itself or the project's own folder.
  const roots = [...new Set((o.projectsRoots ?? []).map(real))].filter(r => r !== home && r !== '/' && !within(project, r))
  const secrets = [...HOME_SECRETS.map(d => join(home, d)), ...(o.secretPaths ?? []).map(real)]
  return [
    '(version 1)',
    '(allow default)',
    '(deny lsopen)',
    '(deny appleevent-send)',
    '(deny user-preference-write)',
    '(deny mach-lookup (global-name "com.apple.pasteboard.1"))',
    ...(roots.length ? [`(deny file-read-data ${roots.map(r => `(subpath ${sb(r)})`).join(' ')})`] : []),
    `(allow file-read-data (subpath ${sb(project)})${o.kernelHome ? ` (subpath ${sb(real(o.kernelHome))})` : ''})`,
    `(deny file-read-data (regex #"${PARTICIPANT_REGEX}") ${secrets.map(p => `(subpath ${sb(p)})`).join(' ')})`,
    // Only its own broker: another project's broker would run commands in that project.
    ...(o.socket ? [`(deny network-outbound (remote unix-socket (subpath ${sb(dirname(o.socket))})))`, `(allow network-outbound (remote unix-socket (path-literal ${sb(o.socket)})))`] : []),
    // Code running in the kernel must not rewrite what runs outside it later: the agent-shell folder (the
    // wrapper, profiles, approval tokens, guard), shell start-up files, launch agents, the brokers' folder.
    `(deny file-write* ${[...(o.agentShellDir ? [real(o.agentShellDir)] : []), ...HOME_STARTUP.map(f => join(home, f)), ...(o.socket ? [dirname(o.socket)] : [])].map(p => `(subpath ${sb(p)})`).join(' ')})`,
    '',
  ].join('\n')
}

/** Files in the home folder that start code later, outside any sandbox. */
export const HOME_STARTUP = ['.zshrc', '.zshenv', '.zprofile', '.zlogin', '.bashrc', '.bash_profile', '.profile', '.bash_login',
  '.config/fish', 'Library/LaunchAgents', '.ssh/rc', '.gitconfig', '.config/git']

const within = (root: string, p: string): boolean => p === root || p.startsWith(root.endsWith('/') ? root : root + '/')

/** Shell code shared by both wrappers: environment, approved commands, app helpers. */
function wrapperHead(o: { dir: string; project: string; realShell: string; runtimeBin?: string; sha: string; helpers: boolean }): string {
  // Only macOS needs helpers outside the sandbox (sandbox-exec cannot nest); under bubblewrap they run inside.
  const entries = o.helpers ? CONFINING_HELPERS.map(h => '.opencode/' + h).join(' ') : ''
  const flagCases = Object.entries(HELPER_FLAGS).map(([h, fl]) => fl.length ? `      ${fl.map(f => `${h}:${f}`).join('|')}) ;;` : '').filter(Boolean).join('\n')
  const forbidden = HELPER_FORBIDDEN.map(w => `*${w}*`).join('|')
  return `#!/bin/sh
# HumanStudy agent shell (generated by the app, agent-sandbox.ts; rewritten on every kernel start).
HS_DIR=${sq(o.dir)}
HS_PROJECT=${sq(o.project)}
HS_REAL=${sq(o.realShell)}
HS_RUNTIME=${sq(o.runtimeBin ?? '')}
HS_ENTRIES=${sq(entries)}
HS_GUARD_ALLOW=${sq(o.runtimeBin ? runtimeRoot(o.runtimeBin) : '')}
unset ${STRIPPED_ENV.join(' ')}
for hs_v in $(env | sed -n 's/^\\([A-Za-z_][A-Za-z0-9_]*\\)=.*/\\1/p' | grep -iE 'KEY|TOKEN|SECRET|PASSW|CREDENTIAL|BYPASS|AUTH'); do
  case "$hs_v" in
    # Pre-relay simulations (Linux, Windows) read the model key from the environment; the run
    # confirmation tells the researcher. With the relay the kernel never has it.
    HUMANSTUDY_DESKTOP_KEY|OPENROUTER_API_KEY) [ "$HUMANSTUDY_RELAY_REQUIRED" = 1 ] && unset "$hs_v" ;;
    GIT_CONFIG_KEY_*) ;;
    *) unset "$hs_v" ;;
  esac
done
unset hs_v
XDG_CACHE_HOME="\${TMPDIR:-/tmp}/humanstudy-agent-cache"; export XDG_CACHE_HOME
MPLCONFIGDIR="\${TMPDIR:-/tmp}/humanstudy-agent-mpl"; export MPLCONFIGDIR
PIP_CACHE_DIR="\${TMPDIR:-/tmp}/humanstudy-agent-pip"; export PIP_CACHE_DIR
# git never runs a project's fsmonitor or hooks (they would run later outside this sandbox, too).
GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0=false GIT_CONFIG_KEY_1=core.hooksPath GIT_CONFIG_VALUE_1=/dev/null
export GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0 GIT_CONFIG_KEY_1 GIT_CONFIG_VALUE_1

# Arguments of a helper on the unsandboxed path: relative paths inside the project that avoid the agent's
# configuration, git and participant data, and only the flags listed per helper (HELPER_FLAGS): no
# child/probe/capture/smoke modes that import project code in-process.
hs_args_ok() {
  hs_n=$1; shift
  if [ "$hs_n" = run_confined.py ]; then
    if [ "$1" = --no-model ]; then
      # Exactly: study_core.py --root . reproduce [--method package or author]
      [ "$2" = .opencode/skills/export/agent/study_core.py ] && [ "$3" = --root ] && [ "$4" = . ] && [ "$5" = reproduce ] || return 1
      shift 5; hs_n=study_core.py
      case "$#:$1:$2" in 0::|2:--method:package|2:--method:author) ;; *) return 1 ;; esac
    else
      [ "$HUMANSTUDY_RELAY_REQUIRED" = 1 ] || return 1  # without the relay run_confined runs unconfined
      [ "$1" = --final ] && shift
      hs_n=run_script
    fi
  fi
  for hs_a in "$@"; do
    case "$hs_a" in /*|*..*|*:*|*@*|~*) return 1 ;; esac
    case "\${hs_a#*=}" in /*|~*) return 1 ;; esac
    hs_l=$(printf '%s' "$hs_a" | tr 'A-Z' 'a-z')
    case "$hs_l" in ${forbidden}) return 1 ;; esac
    case "$hs_a" in
      -*) [ "$hs_n" = run_script ] && continue
          case "$hs_n:\${hs_a%%=*}" in
${flagCases}
            *) return 1 ;;
          esac ;;
    esac
  done
}

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
  # No interpreter flags: -I/-E/-s/-S would drop the in-process guard (it loads through PYTHONPATH).
  hs_s=\${1#./}
  case " $HS_ENTRIES " in *" $hs_s "*) ;; *) return 1 ;; esac
  shift
  hs_args_ok "\${hs_s##*/}" "$@" || return 1
  [ -s "$HS_DIR/trusted.sha256" ] || return 1
  ${o.sha} -c --status "$HS_DIR/trusted.sha256" >/dev/null 2>&1
}

if [ "$#" -eq 2 ] && [ "$1" = "-c" ]; then
  hs_h=$(printf '%s' "$2" | ${o.sha} | cut -c1-64)
  hs_t="$HS_DIR/approved/$hs_h"
  # A token: line 1 its expiry, line 2 the folder the approved call runs in. One use, in that folder.
  if [ -f "$hs_t" ] && mv "$hs_t" "$hs_t.$$" 2>/dev/null; then
    hs_exp=$(sed -n 1p "$hs_t.$$" 2>/dev/null); hs_cwd=$(sed -n 2p "$hs_t.$$" 2>/dev/null); rm -f "$hs_t.$$"
    case "$hs_exp" in ''|*[!0-9]*) ;; *) [ "$(date +%s)" -le "$hs_exp" ] && [ "$(pwd -P)" = "$hs_cwd" ] && { unset HUMANSTUDY_AGENT_RUN; exec "$HS_REAL" -c "$2"; } ;; esac
  fi
  # The helper confines package code itself; HUMANSTUDY_AGENT_RUN makes sandbox_run.py deny participant
  # data to it (the agent cannot unset it: the command is one plain python call).
  # Its own reads go through the in-process guard (guard/sitecustomize.py): no participant data, keys or
  # home folder outside the project and runtime, whatever path a project file names.
  if hs_trusted "$2"; then
    HUMANSTUDY_AGENT_RUN=1 PYTHONPATH="$HS_DIR/guard" HUMANSTUDY_GUARD_PROJECT="$HS_PROJECT" HUMANSTUDY_GUARD_ALLOW="$HS_GUARD_ALLOW"
    export HUMANSTUDY_AGENT_RUN PYTHONPATH HUMANSTUDY_GUARD_PROJECT HUMANSTUDY_GUARD_ALLOW
    exec "$HS_REAL" -c "$2"
  fi
fi
HUMANSTUDY_AGENT_SANDBOX=1 HUMANSTUDY_AGENT_RUN=1; export HUMANSTUDY_AGENT_SANDBOX HUMANSTUDY_AGENT_RUN
`
}

function macosWrapper(o: { dir: string; project: string; realShell: string; runtimeBin?: string }): string {
  return wrapperHead({ ...o, sha: 'shasum -a 256', helpers: true }) + `exec /usr/bin/sandbox-exec -f "$HS_DIR/profile.sb" "$HS_REAL" "$@"\n`
}

/** Linux: bubblewrap. The root is read-only; the project and temp folders are writable; participant-data
 *  folders inside the project (found per command, any case) and credential folders are hidden behind empty
 *  tmpfs mounts (a credential file behind /dev/null); other processes are invisible (own pid namespace).
 *  Unlike macOS, participant data outside the project (other projects) is not hidden. */
function linuxWrapper(o: { dir: string; project: string; realShell: string; runtimeBin?: string; kernelHome: string; secrets: string[]; temps: string[] }): string {
  const bw = ['/usr/bin/bwrap', '/bin/bwrap', '/usr/local/bin/bwrap'].find(existsSync) ?? 'bwrap'
  const names = PARTICIPANT_DATA_DIRS.map(n => `-iname ${sq(n)}`).join(' -o ')
  return wrapperHead({ ...o, sha: 'sha256sum', helpers: false }) + `HS_NL='
'
hs_hide=''
for hs_p in ${[o.kernelHome, ...o.secrets].map(sq).join(' ')}; do
  if [ -d "$hs_p" ]; then hs_hide="$hs_hide--tmpfs$HS_NL$hs_p$HS_NL"; elif [ -e "$hs_p" ]; then hs_hide="$hs_hide--ro-bind$HS_NL/dev/null$HS_NL$hs_p$HS_NL"; fi
done
hs_data=$(find "$HS_PROJECT" -xdev -type d \\( ${names} \\) -prune -print 2>/dev/null)
IFS=$HS_NL; set -f
hs_args="--ro-bind$HS_NL/$HS_NL/$HS_NL--dev$HS_NL/dev$HS_NL--proc$HS_NL/proc$HS_NL--unshare-pid$HS_NL--die-with-parent$HS_NL--bind$HS_NL$HS_PROJECT$HS_NL$HS_PROJECT$HS_NL"
for hs_p in ${o.temps.map(sq).join(' ')}; do [ -d "$hs_p" ] && hs_args="$hs_args--bind$HS_NL$hs_p$HS_NL$hs_p$HS_NL"; done
for hs_p in .opencode opencode.json opencode.jsonc .git .ignore .rgignore; do [ -e "$HS_PROJECT/$hs_p" ] && hs_args="$hs_args--ro-bind$HS_NL$HS_PROJECT/$hs_p$HS_NL$HS_PROJECT/$hs_p$HS_NL"; done
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
  mkdirSync(join(dir, 'guard'), { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, 'guard', 'sitecustomize.py'), HELPER_GUARD, { mode: 0o600 })
  const trusted = trustedFiles.filter(([rel]) => !rel.includes('\n')).map(([rel, hash]) => `${hash}  ${rel}`).join('\n')
  writeFileSync(join(dir, 'trusted.sha256'), trusted ? trusted + '\n' : '', { mode: 0o600 })
  const temps = tempRoots(platform)
  const shell = join(dir, basename(realShell)) // same name, so OpenCode treats it as that shell
  if (kind === 'sandbox-exec') {
    writeFileSync(join(dir, 'profile.sb'), macosAgentProfile({ project, kernelHome: o.kernelHome, secretPaths: o.secretPaths, home: o.home, temps, runtimeBin, socket: o.socket }), { mode: 0o600 })
    if (o.socket) {
      const inner = join(dir, 'inner.sh')
      writeFileSync(inner, macosWrapper({ dir, project, realShell, runtimeBin }), { mode: 0o700 })
      if (!o.secret || !/^[A-Za-z0-9_-]+$/.test(o.secret)) throw new Error('the shell broker needs a secret')
      writeFileSync(join(dir, 'client.pl'), brokerClient(o.secret), { mode: 0o600 })
      writeFileSync(shell, `#!/bin/sh\n# HumanStudy agent shell: the kernel's commands start through the app (shell-broker.ts).\nexec /usr/bin/perl ${sq(join(dir, 'client.pl'))} ${sq(o.socket)} "$@"\n`, { mode: 0o700 })
      return { kind, shell, dir, inner }
    }
    writeFileSync(shell, macosWrapper({ dir, project, realShell, runtimeBin }), { mode: 0o700 })
  } else {
    const home = o.home ?? homedir()
    const secrets = [...HOME_SECRETS.map(d => join(home, d)), ...(o.secretPaths ?? [])]
    writeFileSync(shell, linuxWrapper({ dir, project, realShell, runtimeBin, kernelHome: o.kernelHome, secrets, temps }), { mode: 0o700 })
  }
  return { kind, shell, dir }
}

const IGNORE_START = '# >>> HumanStudy: participant data stays out of the agent\'s search tools (kept by the app)'
const IGNORE_END = '# <<< HumanStudy'
/** The block the app keeps in <project>/.ignore. OpenCode's grep and glob tools run ripgrep, which honours
 *  .ignore files (also with --glob, and from parent folders), so a search without a path never returns
 *  participant data; a search *in* such a folder still reaches the policy and asks. */
export const SEARCH_IGNORE_BLOCK = [IGNORE_START, ...PARTICIPANT_DATA_DIRS.map(d => anyCase(d).replace(/\\/g, '')), IGNORE_END].join('\n')

/** Install or repair the block in <project>/.ignore, keeping the researcher's own lines. */
export function ensureSearchIgnore(project: string): void {
  const file = join(project, '.ignore')
  let text = ''
  try {
    if (lstatSync(file).isSymbolicLink()) rmSync(file, { force: true })
    else text = readFileSync(file, 'utf8')
  } catch { /* missing */ }
  if (searchIgnoreText(text)) return
  const start = text.indexOf(IGNORE_START), end = text.indexOf(IGNORE_END)
  const kept = start >= 0 && end > start ? text.slice(0, start) + text.slice(end + IGNORE_END.length) : text
  writeFileSync(file, (kept.trim() ? kept.trimEnd() + '\n\n' : '') + SEARCH_IGNORE_BLOCK + '\n')
}
const searchIgnoreText = (text: string): boolean => text.includes(SEARCH_IGNORE_BLOCK)
/** Whether the project's .ignore still holds the block (permission-policy asks for path-less searches otherwise). */
export function searchIgnoreInstalled(project: string): boolean {
  try { return !lstatSync(join(project, '.ignore')).isSymbolicLink() && searchIgnoreText(readFileSync(join(project, '.ignore'), 'utf8')) } catch { return false }
}

/** Let one exact command the researcher approved run outside the sandbox: once, in the folder it was
 *  approved for (`cwd`, resolved), within APPROVAL_TTL_S. Returns the token's path, which the app removes
 *  as soon as that tool call ends (completed, failed, aborted), so an approval never outlives its call. */
export function approveCommandOnce(dir: string, command: string, cwd: string, now: number = Date.now()): string {
  const h = createHash('sha256').update(command, 'utf8').digest('hex')
  mkdirSync(join(dir, 'approved'), { recursive: true, mode: 0o700 })
  const file = join(dir, 'approved', h)
  writeFileSync(file, `${Math.floor(now / 1000) + APPROVAL_TTL_S}\n${real(cwd)}\n`, { mode: 0o600 })
  return file
}

/** The in-process guard of the app's helpers when the agent starts them outside its sandbox (macOS cannot
 *  nest the sandbox their package code needs). Loaded as sitecustomize through PYTHONPATH by the wrapper;
 *  an audit hook refuses every open, listing and subprocess path that is participant data, a key folder,
 *  or in the home folder outside the project and the managed runtime. sandbox_run.py's own children
 *  (`python -I` under sandbox-exec) are confined by their profile instead. */
export const HELPER_GUARD = `import os, sys, unicodedata
_P = os.environ.get("HUMANSTUDY_GUARD_PROJECT")
if _P and os.environ.get("HUMANSTUDY_AGENT_RUN") == "1":
    _HOME = os.path.realpath(os.path.expanduser("~"))
    _ALLOW = [os.path.realpath(x) for x in [_P] + os.environ.get("HUMANSTUDY_GUARD_ALLOW", "").split(os.pathsep) if x]
    _NAMES = {${PARTICIPANT_DATA_DIRS.map(d => JSON.stringify(d)).join(', ')}, ${HOME_SECRETS.map(d => JSON.stringify(d.split('/').pop()!.toLowerCase())).join(', ')}}

    def _denied(p):
        try:
            r = os.path.realpath(os.path.abspath(os.fsdecode(p)))
        except Exception:
            return False
        if any(unicodedata.normalize("NFKC", s).lower() in _NAMES for s in r.split(os.sep)):
            return True
        inside = lambda a: r == a or r.startswith(a.rstrip(os.sep) + os.sep)
        return inside(_HOME) and not any(inside(a) for a in _ALLOW)

    def _hook(event, args):
        if event in ("open", "os.listdir", "os.scandir", "os.chdir", "shutil.copyfile", "shutil.copytree"):
            p = args[0] if args else None
            if isinstance(p, (str, bytes, os.PathLike)) and _denied(p):
                raise PermissionError("HumanStudy: %s is not readable when the agent starts this helper" % os.fsdecode(p))
        elif event == "subprocess.Popen":
            exe, argv = args[0], args[1]
            if os.path.basename(os.fsdecode(exe or "")) == "sandbox-exec":
                return
            for a in ([argv] if isinstance(argv, (str, bytes)) else list(argv or [])):
                if isinstance(a, (str, bytes, os.PathLike)) and os.sep in os.fsdecode(a) and os.path.exists(a) and _denied(a):
                    raise PermissionError("HumanStudy: %s is not readable when the agent starts this helper" % os.fsdecode(a))

    sys.addaudithook(_hook)
`

/** The kernel-side client of the shell broker (system perl, core modules only). It sends the shell's
 *  arguments and working folder, then relays the command's output (frames: 1 byte o/e/x, 4 byte length)
 *  and exits with its status. When it is killed (OpenCode's timeout, abort), the connection closes and the
 *  broker kills the command. No environment is sent: the broker uses the kernel's, minus secrets. */
export const brokerClient = (secret: string): string => `use strict; use warnings; use IO::Socket::UNIX; use IO::Select; use Socket qw(SOCK_STREAM); use Cwd qw(getcwd); use JSON::PP;
my $path = shift @ARGV;
my $s = IO::Socket::UNIX->new(Type => SOCK_STREAM, Peer => $path) or do { print STDERR "HumanStudy: the app's shell service is not reachable ($!)\\n"; exit 125 };
binmode $s; binmode STDOUT; binmode STDERR; binmode STDIN; $| = 1;
my $secret = '${secret}';
my $terminal = (@ARGV >= 2 && $ARGV[0] eq '--terminal') ? $ARGV[1] : undef;
my ($rows, $cols) = (24, 80);
if (defined $terminal) { my $sz = \`stty size 2>/dev/null\`; ($rows, $cols) = ($1, $2) if $sz =~ /^(\\d+) (\\d+)/; system('stty raw -echo 2>/dev/null') }
END { system('stty sane 2>/dev/null') if defined $terminal }
print $s JSON::PP->new->utf8->encode(defined $terminal ? { secret => $secret, terminal => $terminal, rows => $rows + 0, cols => $cols + 0 } : { secret => $secret, args => [@ARGV], cwd => getcwd() }) . "\\n";
my $sel = IO::Select->new($s); $sel->add(\\*STDIN) if defined $terminal;
my $buf = '';
while (1) {
  for my $fh ($sel->can_read) {
    if ($fh == \\*STDIN) { my $n = sysread(STDIN, my $in, 4096); if (!$n) { $sel->remove(\\*STDIN); next } print $s pack('a1 N', 'i', length $in) . $in; next }
    my $n = sysread($s, my $chunk, 65536); exit 125 unless $n; $buf .= $chunk;
    while (length($buf) >= 5) {
      my ($t, $len) = unpack('a1 N', $buf); last if length($buf) < 5 + $len;
      my $data = substr($buf, 5, $len); $buf = substr($buf, 5 + $len);
      if ($t eq 'o') { syswrite(STDOUT, $data) } elsif ($t eq 'e') { syswrite(STDERR, $data) } elsif ($t eq 'x') { exit(int($data)) }
    }
  }
}
`

/** For tests and diagnostics: is this file the generated wrapper? */
export const isAgentShell = (p: string): boolean => {
  try { return statSync(p).isFile() && readFileSync(p, 'utf8').startsWith('#!/bin/sh\n# HumanStudy agent shell') } catch { return false }
}
