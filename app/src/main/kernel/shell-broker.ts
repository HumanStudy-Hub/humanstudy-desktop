// The app's shell broker (macOS). The OpenCode kernel runs under its own minimal sandbox
// (agent-sandbox.ts macosKernelProfile), and a macOS sandbox is inherited by every child and cannot be
// nested. So the kernel's shell is a small client (agent-sandbox.ts BROKER_CLIENT) that asks the app,
// over a unix socket only the kernel can reach, to start the command; the app starts the agent-shell
// wrapper (approved command, confining helper, or sandbox-exec with the agent profile) outside the
// kernel's sandbox and relays its output and exit status. Closing the connection kills the command.
//
// Wire format, client -> app: one JSON line {args: string[], cwd: string}. App -> client: frames of
// 1 byte type ('o' stdout, 'e' stderr, 'x' exit status as decimal text) + 4 byte big-endian length.
import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

export interface ShellBroker { socket: string; close(): Promise<void> }

/** A short socket path (macOS limits it to 104 bytes) in a folder the agent's shell can neither read nor
 *  write: ~/.humanstudy/run/<hash>.sock. */
export function brokerSocketPath(project: string, home: string = homedir()): string {
  return join(home, '.humanstudy', 'run', createHash('sha256').update(project).digest('hex').slice(0, 12) + '.sock')
}

const frame = (type: 'o' | 'e' | 'x', data: Buffer): Buffer => {
  const h = Buffer.alloc(5)
  h.write(type, 0, 'latin1')
  h.writeUInt32BE(data.length, 1)
  return Buffer.concat([h, data])
}

/** Start the broker for one project. `inner` is the agent-shell wrapper; `env` the kernel's environment
 *  (the wrapper drops its secrets); every request must name a folder that exists. */
export function startShellBroker(o: { socket: string; inner: string; env: NodeJS.ProcessEnv }): Promise<ShellBroker> {
  mkdirSync(join(o.socket, '..'), { recursive: true, mode: 0o700 })
  try { chmodSync(join(o.socket, '..'), 0o700) } catch { /* best effort */ }
  rmSync(o.socket, { force: true })
  const children = new Set<ChildProcess>()
  const kill = (c: ChildProcess): void => {
    if (c.exitCode !== null || c.signalCode !== null) return
    try { if (c.pid) process.kill(-c.pid, 'SIGKILL') } catch { try { c.kill('SIGKILL') } catch { /* gone */ } }
  }
  const serve = (sock: Socket): void => {
    let head = Buffer.alloc(0)
    let child: ChildProcess | undefined
    const fail = (msg: string, code = 125): void => {
      if (sock.writable) { sock.write(frame('e', Buffer.from(`HumanStudy: ${msg}\n`))); sock.end(frame('x', Buffer.from(String(code)))) }
    }
    const onData = (chunk: Buffer): void => {
      head = Buffer.concat([head, chunk])
      const nl = head.indexOf(10)
      if (nl < 0) { if (head.length > 1 << 20) { sock.off('data', onData); fail('request too long') } return }
      sock.off('data', onData)
      let req: { args?: unknown; cwd?: unknown }
      try { req = JSON.parse(head.subarray(0, nl).toString('utf8')) } catch { return fail('bad request') }
      const args = Array.isArray(req.args) && req.args.every(a => typeof a === 'string') ? req.args as string[] : null
      const cwd = typeof req.cwd === 'string' ? req.cwd : ''
      if (!args) return fail('bad request')
      try { if (!statSync(cwd).isDirectory()) return fail(`no such folder: ${cwd}`, 1) } catch { return fail(`no such folder: ${cwd}`, 1) }
      child = spawn(o.inner, args, { cwd, env: o.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
      children.add(child)
      child.stdout?.on('data', (d: Buffer) => { if (sock.writable) sock.write(frame('o', d)) })
      child.stderr?.on('data', (d: Buffer) => { if (sock.writable) sock.write(frame('e', d)) })
      child.on('error', e => fail(String(e.message ?? e)))
      child.on('close', (code, signal) => {
        if (child) children.delete(child)
        if (sock.writable) sock.end(frame('x', Buffer.from(String(code ?? (signal ? 128 + 9 : 1)))))
      })
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
        close: () => new Promise<void>(r => {
          for (const c of children) kill(c)
          server.close(() => { rmSync(o.socket, { force: true }); r() })
          if (!existsSync(o.socket)) r()
        }),
      })
    })
  })
}
