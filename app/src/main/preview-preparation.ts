import { createHash } from 'node:crypto'
import { lstat, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProjectSnapshot } from '../preload/types'
import { assertProjectWritePath, saveProjectCopy, saveProjectText } from './program-save'
import { withProgramLock } from './program-lock'
import { confinedPython, pythonResourceLimits, withScratch } from './protocol-readiness'

type Status = ProjectSnapshot['previewPreparation']
type Failure = 'runtime_unavailable' | 'invalid_protocol' | 'preview_check_failed' | 'limits' | 'io'

const CPU_SECONDS = 60
const SKIP_WRITE = Symbol('preview inputs changed or project became busy')
const RUNNER = [
  pythonResourceLimits(CPU_SECONDS),
  'import runpy, sys',
  'sys.argv = sys.argv[1:]',
  'runpy.run_path(sys.argv[0], run_name="__main__")',
].join('\n')

async function fileInfo(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
}

async function fileBytes(path: string): Promise<Buffer | null> {
  const info = await fileInfo(path)
  if (!info) return null
  if (!info.isFile()) throw Error('Preview input is not a regular file.')
  return readFile(path)
}

function templateVersion(html: string): number | null {
  const head = html.replace(/<!--[\s\S]*?-->/g, '').match(/<head\b[^>]*>([\s\S]*?)<\/head>/i)?.[1]
    ?.replace(/<(script|style|title|template|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
  const tags = head?.matchAll(/<([a-z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)
  for (const [, tag, attrs] of tags ?? []) {
    if (tag.toLowerCase() !== 'meta') continue
    const fields = new Map(Array.from(attrs.matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g),
      ([, name, double, single, unquoted]) => [name.toLowerCase(), double ?? single ?? unquoted]))
    if (fields.get('name') !== 'hs-preview-template-version') continue
    const content = fields.get('content')
    const version = content && /^\d+$/.test(content) ? Number(content) : NaN
    if (Number.isFinite(version)) return version
  }
  return null
}

function protocolIdentity(html: string): { id?: string; sha256?: string } | null {
  const match = html.match(/<script\b[^>]*\bid=["']hs-protocol["'][^>]*>([\s\S]*?)<\/script>/i)
  try { return match ? JSON.parse(match[1]) : null } catch { return null }
}

export function createPreviewPreparation(options: {
  python(): Promise<string | null>
  files(): [string, string][]
  version(): number
  busy(dir: string): boolean
  settled(dir: string, result: { written: boolean; error?: Failure }): void
}) {
  const running = new Set<string>()
  const checking = new Map<string, Promise<Status>>()
  const current = new Map<string, string>()
  const failed = new Map<string, string>()
  // The refresh triggered by a failure still needs to show its status. A new preparation
  // request clears this display state and retries immediately.
  const transientStatus = new Map<string, 'runtime_unavailable' | 'io'>()
  const deferred = new Set<string>()

  function deferIfBusy(dir: string): boolean {
    if (!options.busy(dir)) return false
    deferred.add(dir)
    return true
  }

  async function inspect(dir: string): Promise<Status> {
    const protocol = join(dir, 'protocol.json')
    const preview = join(dir, 'artifacts', 'preview.html')
    try {
      const protocolInfo = await fileInfo(protocol)
      if (!protocolInfo) { current.delete(dir); failed.delete(dir); return undefined }
      await assertProjectWritePath(dir, preview)
      const previewInfo = await fileInfo(preview)
      const version = options.version()
      const stamp = JSON.stringify([version, ...[protocolInfo, previewInfo].map(info =>
        info && [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs])])
      if (current.get(dir) === stamp) return undefined
      if (failed.get(dir) === stamp) return 'failed'
      current.delete(dir)
      const previous = await fileBytes(preview)
      const previousHtml = previous?.toString('utf8')
      const previousVersion = previousHtml === undefined ? null : templateVersion(previousHtml)
      if (previousHtml !== undefined && previousVersion === null) {
        failed.delete(dir)
        current.set(dir, stamp)
        return undefined
      }
      await assertProjectWritePath(dir, protocol)
      const raw = await fileBytes(protocol)
      if (!raw) return undefined
      if (deferIfBusy(dir)) return undefined
      let id: unknown
      try { id = JSON.parse(raw.toString('utf8')).id } catch { /* reported below */ }
      if (typeof id !== 'string' || !id) {
        failed.set(dir, stamp)
        options.settled(dir, { written: false, error: 'invalid_protocol' })
        return 'failed'
      }
      const hash = createHash('sha256').update(raw).digest('hex')
      if (previousHtml !== undefined && previousVersion !== null &&
          previousVersion >= version && protocolIdentity(previousHtml)?.sha256 === hash) {
        failed.delete(dir)
        current.set(dir, stamp)
        return undefined
      }
      running.add(dir)
      void generate(dir, protocol, preview, raw, id, hash, version, previous).then(result => {
        running.delete(dir)
        if (result.error === 'runtime_unavailable' || result.error === 'io') transientStatus.set(dir, result.error)
        else if (result.error) failed.set(dir, stamp)
        resume(dir)
        options.settled(dir, result)
      })
      return 'preparing'
    } catch {
      transientStatus.set(dir, 'io')
      options.settled(dir, { written: false, error: 'io' })
      return 'failed'
    }
  }

  async function generate(dir: string, protocol: string, preview: string, raw: Buffer, id: string,
    hash: string, version: number, previous: Buffer | null): Promise<{ written: boolean; error?: Failure }> {
    try {
      const python = await options.python()
      if (deferIfBusy(dir)) return { written: false }
      if (!python) return { written: false, error: 'runtime_unavailable' }
      return await withScratch(options.files(), async (work, home) => {
        if (deferIfBusy(dir)) return { written: false }
        const out = join(home, 'preview.html')
        const script = join(work, 'skills', 'preview', 'make_preview.py')
        const result = await confinedPython(python, RUNNER, [script, '--project', dir, '--out', out],
          home, '', 90_000, { cpuSeconds: CPU_SECONDS })
        if (deferIfBusy(dir)) return { written: false }
        if (result.limit) return { written: false, error: 'limits' }
        if (result.exitCode !== 0) return { written: false, error: 'preview_check_failed' }
        const html = await readFile(out, 'utf8')
        // The builder binds the rendered pages to the exact bytes it read. If the protocol
        // changed since this job started, the next project read can prepare that revision.
        const identity = protocolIdentity(html)
        if ((templateVersion(html) ?? -1) < version || identity?.id !== id || identity.sha256 !== hash) {
          if (!(await fileBytes(protocol))?.equals(raw)) return { written: false }
          return { written: false, error: 'preview_check_failed' }
        }
        const previousCopy = join(home, 'preview.prev.html')
        if (previous) await writeFile(previousCopy, previous)
        await assertProjectWritePath(dir, protocol)
        await assertProjectWritePath(dir, preview)
        await withProgramLock(protocol, () => saveProjectText(preview, html, {
          beforeReplace: async () => {
            async function requireCurrent() {
              if (!(await fileBytes(protocol))?.equals(raw)) throw SKIP_WRITE
              const current = await fileBytes(preview)
              if (previous ? !current?.equals(previous) : current !== null) throw SKIP_WRITE
              if (deferIfBusy(dir)) throw SKIP_WRITE
            }
            await requireCurrent()
            if (previous) {
              const backup = join(dir, 'artifacts', 'preview.prev.html')
              await assertProjectWritePath(dir, backup)
              await saveProjectCopy(previousCopy, backup)
              await requireCurrent()
            }
          },
        }))
        return { written: true }
      })
    } catch (error) {
      if (error === SKIP_WRITE) return { written: false }
      return { written: false, error: 'io' }
    }
  }

  function prepare(dir: string, refresh = false): Promise<Status> {
    if (deferIfBusy(dir)) return Promise.resolve(undefined)
    if (running.has(dir)) return Promise.resolve('preparing')
    const pending = checking.get(dir)
    if (pending) return pending
    deferred.delete(dir)
    if (refresh && transientStatus.has(dir)) return Promise.resolve('failed')
    transientStatus.delete(dir)
    const check = inspect(dir).finally(() => { checking.delete(dir) })
    checking.set(dir, check)
    return check
  }

  function resume(dir: string): void {
    if (deferred.has(dir) && !options.busy(dir)) void prepare(dir)
  }

  function runtimeReady(): void {
    for (const [dir, error] of transientStatus) {
      if (error === 'runtime_unavailable') void prepare(dir)
    }
  }

  return { prepare, resume, runtimeReady }
}
