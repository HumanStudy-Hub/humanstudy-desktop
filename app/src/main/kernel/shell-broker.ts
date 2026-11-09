// The app's shell broker (macOS). The OpenCode kernel runs under its own minimal sandbox
// (agent-sandbox.ts macosKernelProfile), and a macOS sandbox is inherited by every child and cannot be
// nested. So the kernel's shell is a small client (agent-sandbox.ts brokerClient) that asks the app,
// over a unix socket only that project's kernel can reach, to start the command:
//
//   agent      `<shell> -c <command>` (the bash tool): the agent-shell wrapper (approved command,
//              confining helper, or sandbox-exec with the agent profile), outside the kernel's sandbox;
//   researcher OpenCode's login form for a `!` command the app itself just sent (expectResearcherCommand):
//              the researcher's real shell, unconfined, as before the kernel was sandboxed;
//   terminal   the researcher's Terminal view (a ticket from terminalTicket): their login shell under a
//              pseudo-terminal (`script`), unconfined, with stdin relayed.
//
// Every request carries the per-launch secret written only into this project's client.pl (the agent
// profile cannot read the kernel folder), compared in constant time; the folder must be inside the
// project. Anything else is refused.
//
// Wire format, client -> app: one JSON line {secret, args, cwd} or {secret, terminal: ticket, rows, cols},
// then (terminal only) 'i' frames of input. App -> client: frames of 1 byte type ('o' stdout, 'e' stderr,
// 'x' exit status as decimal text) + 4 byte big-endian length + data.
import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { homedir } from 'node:os'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { isAbsolute, join, relative } from 'node:path'

export interface ShellBroker {
  socket: string
  /** The app is about to send this `!` command to the kernel: let its login-form call run as the researcher. */
  expectResearcherCommand(command: string): void
  /** A one-use ticket for the researcher's Terminal view. */
  terminalTicket(): string
  close(): Promise<void>
}

/** The folder of every project's broker socket. Both sandbox profiles deny connecting into it, except the
 *  kernel's own socket. */
export const brokerRunDir = (home: string = homedir()): string => join(home, '.humanstudy', 'run')

/** A short socket path (macOS limits it to 104 bytes): ~/.humanstudy/run/<hash>.sock. */
export function brokerSocketPath(project: string, home: string = homedir()): string {
  return join(brokerRunDir(home), createHash('sha256').update(project).digest('hex').slice(0, 12) + '.sock')
}

/** Runs a command under a new pseudo-terminal (macOS ioctls on /dev/ptmx) and relays it to stdin/stdout:
 *  Node has no pty, and `script` needs a terminal on its own stdin. Arguments: rows, cols, command... */
export const PTY_HELPER = `use strict; use warnings; use POSIX qw(setsid _exit);
my ($rows, $cols, @cmd) = @ARGV;
open(my $m, '+<', '/dev/ptmx') or die "ptmx: $!";
ioctl($m, 0x20007454, 0) or die "grant: $!";
ioctl($m, 0x20007452, 0) or die "unlock: $!";
my $name = "\\0" x 128; ioctl($m, 0x40807453, $name) or die "name: $!"; $name =~ s/\\0.*//s;
my $pid = fork() // die "fork: $!";
if (!$pid) {
  setsid(); close $m;
  open(my $s, '+<', $name) or _exit(127);
  ioctl($s, 0x20007461, 0);
  ioctl($s, 0x80087467, pack('S4', $rows, $cols, 0, 0));
  open(STDIN, '<&', $s); open(STDOUT, '>&', $s); open(STDERR, '>&', $s);
  exec @cmd or _exit(127);
}
binmode STDIN; binmode STDOUT; $| = 1;
open(my $ctl, '<&=', 3);   # window sizes, "rows cols" per line (the broker's 'w' frames)
my $rin = ''; vec($rin, fileno(STDIN), 1) = 1; vec($rin, fileno($m), 1) = 1; vec($rin, fileno($ctl), 1) = 1 if $ctl;
my $cbuf = '';
while (1) {
  my $r = $rin; next unless select($r, undef, undef, undef) > 0;
  if ($ctl && vec($r, fileno($ctl), 1)) {
    my $n = sysread($ctl, my $b, 256);
    if (!$n) { vec($rin, fileno($ctl), 1) = 0 } else { $cbuf .= $b; while ($cbuf =~ s/^(\\d+) (\\d+)\\n//) { ioctl($m, 0x80087467, pack('S4', $1, $2, 0, 0)) } }
  }
  if (vec($r, fileno(STDIN), 1)) { my $n = sysread(STDIN, my $b, 4096); if (!$n) { vec($rin, fileno(STDIN), 1) = 0 } else { syswrite($m, $b) } }
  if (vec($r, fileno($m), 1)) { my $n = sysread($m, my $b, 65536); last unless $n; syswrite(STDOUT, $b) }
}
waitpid($pid, 0); exit($? >> 8);
`

const frame = (type: 'o' | 'e' | 'x', data: Buffer): Buffer => {
  const h = Buffer.alloc(5)
  h.write(type, 0, 'latin1')
  h.writeUInt32BE(data.length, 1)
  return Buffer.concat([h, data])
}

const sameSecret = (a: unknown, b: string): boolean => {
  if (typeof a !== 'string') return false
  const x = createHash('sha256').update(a).digest(), y = createHash('sha256').update(b).digest()
  return timingSafeEqual(x, y)
}

export interface BrokerOptions {
  socket: string
  /** The agent-shell wrapper. */
  inner: string
  /** The kernel's environment (the wrapper drops its secrets). */
  env: NodeJS.ProcessEnv
  /** Per-launch secret, also written into this project's client.pl. */
  secret: string
  /** The project: every command runs in a folder inside it. */
  project: string
  /** The researcher's own shell and environment, for `!` commands and the Terminal view. */
  realShell: string
  researcherEnv: NodeJS.ProcessEnv
  /** How long an expected `!` command or a terminal ticket stays valid. */
  ttlMs?: number
}

/** Start the broker for one project. */
export function startShellBroker(o: BrokerOptions): Promise<ShellBroker> {
  mkdirSync(join(o.socket, '..'), { recursive: true, mode: 0o700 })
  try { chmodSync(join(o.socket, '..'), 0o700) } catch { /* best effort */ }
  rmSync(o.socket, { force: true })
  const ttl = o.ttlMs ?? 60_000
  const project = realpathSync(o.project)
  const children = new Set<ChildProcess>()
  const researcher = new Map<string, number>()   // expected `!` command -> expiry
  const tickets = new Map<string, number>()      // terminal ticket -> expiry
  const kill = (c: ChildProcess): void => {
    if (c.exitCode !== null || c.signalCode !== null) return
    try { if (c.pid) process.kill(-c.pid, 'SIGKILL') } catch { try { c.kill('SIGKILL') } catch { /* gone */ } }
  }
  const take = (m: Map<string, number>, key: string): boolean => {
    const exp = m.get(key)
    m.delete(key)
    return exp !== undefined && exp >= Date.now()
  }
  const insideProject = (cwd: string): string | null => {
    try {
      const r = realpathSync(cwd)
      if (!statSync(r).isDirectory()) return null
      const rel = relative(project, r)
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)) ? r : null
    } catch { return null }
  }
  const serve = (sock: Socket): void => {
    let head = Buffer.alloc(0)
    let child: ChildProcess | undefined
    let input = Buffer.alloc(0)
    const fail = (msg: string, code = 125): void => {
      if (sock.writable) { sock.write(frame('e', Buffer.from(`HumanStudy: ${msg}\n`))); sock.end(frame('x', Buffer.from(String(code)))) }
    }
    const pump = (chunk: Buffer): void => {
      // Terminal input frames ('i').
      input = Buffer.concat([input, chunk])
      while (input.length >= 5) {
        const len = input.readUInt32BE(1)
        if (input.length < 5 + len) break
        if (input[0] === 0x69 && child?.stdin?.writable) child.stdin.write(input.subarray(5, 5 + len))
        // 'w': a new window size "rows cols" for the terminal's pseudo-terminal (fd 3 of PTY_HELPER).
        else if (input[0] === 0x77) {
          const m = /^(\d{1,4}) (\d{1,4})$/.exec(input.subarray(5, 5 + len).toString('latin1'))
          const ctl = child?.stdio[3] as NodeJS.WritableStream | null | undefined
          if (m && ctl) ctl.write(`${m[1]} ${m[2]}\n`)
        }
        input = input.subarray(5 + len)
      }
    }
    const run = (file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, stdin: boolean): void => {
      child = spawn(file, args, { cwd, env, stdio: stdin ? ['pipe', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'], detached: true })
      children.add(child)
      child.stdout?.on('data', (d: Buffer) => { if (sock.writable) sock.write(frame('o', d)) })
      child.stderr?.on('data', (d: Buffer) => { if (sock.writable) sock.write(frame('e', d)) })
      child.on('error', e => fail(String(e.message ?? e)))
      child.on('close', (code, signal) => {
        if (child) children.delete(child)
        if (sock.writable) sock.end(frame('x', Buffer.from(String(code ?? (signal ? 128 + 9 : 1)))))
      })
    }
    const onData = (chunk: Buffer): void => {
      head = Buffer.concat([head, chunk])
      const nl = head.indexOf(10)
      if (nl < 0) { if (head.length > 1 << 20) { sock.off('data', onData); fail('request too long') } return }
      sock.off('data', onData)
      const rest = head.subarray(nl + 1)
      let req: { secret?: unknown; args?: unknown; cwd?: unknown; terminal?: unknown; rows?: unknown; cols?: unknown }
      try { req = JSON.parse(head.subarray(0, nl).toString('utf8')) } catch { return fail('bad request') }
      if (!sameSecret(req.secret, o.secret)) return fail('not authorised')
      if (typeof req.terminal === 'string') {
        if (!take(tickets, req.terminal)) return fail('the terminal ticket is not valid')
        const rows = Number.isInteger(req.rows) ? req.rows as number : 24, cols = Number.isInteger(req.cols) ? req.cols as number : 80
        // A pseudo-terminal of its own (PTY_HELPER); the client puts its side in raw mode.
        run('/usr/bin/perl', ['-e', PTY_HELPER, String(rows), String(cols), o.realShell, '-l'], project, o.researcherEnv, true)
        sock.on('data', pump)
        if (rest.length) pump(rest)
        return
      }
      const args = Array.isArray(req.args) && req.args.every(a => typeof a === 'string') ? req.args as string[] : null
      const cwd = typeof req.cwd === 'string' ? insideProject(req.cwd) : null
      if (!args) return fail('bad request')
      if (!cwd) return fail(`commands run inside the project only (${String(req.cwd)})`, 1)
      // The bash tool: exactly `-c <command>`, through the agent-shell wrapper.
      if (args.length === 2 && args[0] === '-c') return run(o.inner, args, cwd, o.env, false)
      // OpenCode's login form for a `!` command (Shell.args): the researcher's own, if the app sent it.
      if (args.length === 5 && args[0] === '-l' && args[1] === '-c' && args[3] === 'opencode') {
        const cmd = [...researcher.keys()].find(c => args[2].includes(`eval ${JSON.stringify(c)}`))
        if (cmd !== undefined && take(researcher, cmd)) return run(o.realShell, args, cwd, o.researcherEnv, false)
      }
      fail('this shell call is not allowed')
    }
    sock.on('data', onData)
    sock.on('close', () => { if (child) kill(child) })
    sock.on('error', () => { if (child) kill(child) })
  }
  const server: Server = createServer(serve)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(o.socket, () => {
      try { chmodSync(o.socket, 0o600) } catch { /* best effort */ }
      resolve({
        socket: o.socket,
        expectResearcherCommand: (command: string) => { researcher.set(command, Date.now() + ttl) },
        terminalTicket: () => { const t = randomBytes(18).toString('base64url'); tickets.set(t, Date.now() + ttl); return t },
        close: () => new Promise<void>(r => {
          for (const c of children) kill(c)
          server.close(() => { rmSync(o.socket, { force: true }); r() })
          if (!existsSync(o.socket)) r()
        }),
      })
    })
  })
}
