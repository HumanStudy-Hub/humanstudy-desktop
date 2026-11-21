import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProjectSnapshot } from '../preload/types'
import { assertProjectWritePath, saveProjectText } from './program-save'
import { withProgramLock } from './program-lock'
import { confinedPython, pythonResourceLimits, withScratch } from './protocol-readiness'

type Status = ProjectSnapshot['previewPreparation']
type Failure = 'runtime_unavailable' | 'invalid_protocol' | 'preview_check_failed' | 'limits' | 'io'

const CPU_SECONDS = 60
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

function currentPreview(html: string, id: string, sha256: string, version: number): boolean {
  const match = html.match(/<script\b[^>]*\bid=["']hs-protocol["'][^>]*>([\s\S]*?)<\/script>/i)
  try {
    const identity = JSON.parse(match?.[1] ?? '')
    if (identity.id !== id || identity.sha256 !== sha256) return false
  } catch { return false }
  const template = html.match(/<meta\b(?=[^>]*\sname=["']hs-preview-template-version["'])[^>]*>/i)?.[0]
  if (template) return Number(template.match(/\scontent=["'](\d+)["']/i)?.[1]) >= version
  // Preview templates shipped before versioning carry this data block. A hand-authored
  // preview with a current protocol identity can omit template metadata altogether.
  return !/<script\b[^>]*\sid=["']hs-preview["']/i.test(html)
}

export function createPreviewPreparation(options: {
  python(): Promise<string | null>
  files(): [string, string][]
  version(): number
  settled(dir: string, result: { written: boolean; error?: Failure }): void
}) {
  const running = new Set<string>()
  const checking = new Map<string, Promise<Status>>()
  const failed = new Map<string, string>()

  async function inspect(dir: string): Promise<Status> {
    const protocol = join(dir, 'protocol.json')
    const preview = join(dir, 'artifacts', 'preview.html')
    let stamp = ''
    try {
      const protocolInfo = await fileInfo(protocol)
      if (!protocolInfo) { failed.delete(dir); return undefined }
      await assertProjectWritePath(dir, protocol)
      await assertProjectWritePath(dir, preview)
      const previewInfo = await fileInfo(preview)
      stamp = JSON.stringify([protocolInfo, previewInfo].map(info =>
        info && [info.ino, info.size, info.mtimeMs, info.ctimeMs]))
      if (failed.get(dir) === stamp) return 'failed'
      const raw = await fileBytes(protocol)
      if (!raw) return undefined
      let id: unknown
      try { id = JSON.parse(raw.toString('utf8')).id } catch { /* reported below */ }
      if (typeof id !== 'string' || !id) {
        failed.set(dir, stamp)
        options.settled(dir, { written: false, error: 'invalid_protocol' })
        return 'failed'
      }
      const hash = createHash('sha256').update(raw).digest('hex')
      const previous = (await fileBytes(preview))?.toString('utf8') ?? null
      const version = options.version()
      if (previous !== null && currentPreview(previous, id, hash, version)) {
        failed.delete(dir)
        return undefined
      }
      running.add(dir)
      void generate(dir, protocol, preview, raw, id, hash, version, previous).then(result => {
        running.delete(dir)
        if (result.error) failed.set(dir, stamp)
        else failed.delete(dir)
        options.settled(dir, result)
      })
      return 'preparing'
    } catch {
      if (failed.get(dir) !== stamp) {
        failed.set(dir, stamp)
        options.settled(dir, { written: false, error: 'io' })
      }
      return 'failed'
    }
  }

  async function generate(dir: string, protocol: string, preview: string, raw: Buffer, id: string,
    hash: string, version: number, previous: string | null): Promise<{ written: boolean; error?: Failure }> {
    try {
      const python = await options.python()
      if (!python) return { written: false, error: 'runtime_unavailable' }
      return await withScratch(options.files(), async (work, home) => {
        const out = join(home, 'preview.html')
        const script = join(work, 'skills', 'preview', 'make_preview.py')
        const result = await confinedPython(python, RUNNER, [script, '--project', dir, '--out', out],
          home, '', 90_000, { cpuSeconds: CPU_SECONDS })
        if (result.limit) return { written: false, error: 'limits' }
        if (result.exitCode !== 0) return { written: false, error: 'preview_check_failed' }
        const html = await readFile(out, 'utf8')
        // The builder binds the rendered pages to the exact bytes it read. If the protocol
        // changed since this job started, the next project read can prepare that revision.
        if (!currentPreview(html, id, hash, version)) {
          if (!(await fileBytes(protocol))?.equals(raw)) return { written: false }
          return { written: false, error: 'preview_check_failed' }
        }
        await assertProjectWritePath(dir, protocol)
        await assertProjectWritePath(dir, preview)
        const written = await withProgramLock(protocol, async () => {
          if (!(await fileBytes(protocol))?.equals(raw)) return false
          if (((await fileBytes(preview))?.toString('utf8') ?? null) !== previous) return false
          await saveProjectText(preview, html, { ifUnchanged: previous })
          return true
        })
        return { written }
      })
    } catch {
      return { written: false, error: 'io' }
    }
  }

  return function prepare(dir: string): Promise<Status> {
    if (running.has(dir)) return Promise.resolve('preparing')
    const pending = checking.get(dir)
    if (pending) return pending
    const check = inspect(dir).finally(() => { checking.delete(dir) })
    checking.set(dir, check)
    return check
  }
}
