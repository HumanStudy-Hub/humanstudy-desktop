// Managed research runtime (Python + PDF tools), installed next to the kernel on first run. The logic is
// in runtime-core.ts; this file owns the paths (userData/runtime/<version>), the bundled lock file and
// helper modules (pack/runtime), and the status. Files are written by the app itself, so they carry no
// com.apple.quarantine attribute and Gatekeeper never prompts for them.
import { app } from 'electron'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type PartStatus,
  type RuntimeProgress,
  installRuntime,
  isInstalled,
  pickPython,
  runtimePaths,
  runtimeVersion,
  stubFiles,
  writeFiles,
} from './runtime-core'
import { InstallCancelled } from './opencode-install-core'

const lockSrc = import.meta.glob('../../../pack/runtime/requirements.lock', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const libSrc = import.meta.glob('../../../pack/runtime/lib/*.py', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const LOCK = Object.values(lockSrc)[0] ?? ''
const LIB: Record<string, string> = Object.fromEntries(Object.entries(libSrc).map(([k, v]) => [k.split('/').pop() as string, v]))

export const RUNTIME_VERSION = runtimeVersion(LOCK)
const runtimeRoot = (): string => join(app.getPath('userData'), 'runtime')
const installDir = (): string => join(runtimeRoot(), RUNTIME_VERSION)
const stubDir = (): string => join(runtimeRoot(), 'stub')

let status: PartStatus = { state: 'checking' }
const listeners = new Set<(s: PartStatus) => void>()
function set(s: PartStatus): void {
  status = s
  for (const l of listeners) l(status)
}
export const runtimeStatus = (): PartStatus => status
export function onRuntimeProgress(cb: (s: PartStatus) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** Tells the kernel factory where the tools are: the runtime's bin once installed, else a stub bin whose
 *  python / pdftotext / ... explain that the runtime is missing instead of reaching the system Python. */
async function publish(ready: boolean): Promise<void> {
  if (ready) {
    process.env.HUMANSTUDY_RUNTIME_BIN = runtimePaths(installDir(), process.platform).bin
    return
  }
  await writeFiles(stubDir(), stubFiles(process.platform))
  process.env.HUMANSTUDY_RUNTIME_BIN = stubDir()
}

let abort: AbortController | null = null
let inflight: Promise<void> | null = null

export function cancelRuntimeInstall(): void {
  abort?.abort()
}

/** Resolves when the runtime is usable; rejects (status 'error') otherwise. Older runtime folders are removed. */
export function ensureRuntime(): Promise<void> {
  inflight ??= install().finally(() => {
    inflight = null
  })
  return inflight
}

async function install(): Promise<void> {
  try {
    if (!LOCK) throw new Error('requirements.lock is not bundled')
    if (!pickPython(process.platform, process.arch)) throw new Error(`no research runtime for ${process.platform}-${process.arch}`)
    await mkdir(runtimeRoot(), { recursive: true })
    const have = await isInstalled(installDir(), process.platform, LOCK)
    if (!have) {
      await publish(false)
      set({ state: 'downloading', percent: 0 })
    }
    abort = new AbortController()
    let last = -1
    await installRuntime({
      root: installDir(),
      platform: process.platform,
      arch: process.arch,
      lock: LOCK,
      lib: LIB,
      signal: abort.signal,
      onProgress: (p: RuntimeProgress) => {
        if (p.percent !== last) {
          last = p.percent
          set({ state: 'downloading', percent: p.percent })
        }
      },
    })
    await publish(true)
    set({ state: 'ready', percent: 100 })
    void prune()
  } catch (e) {
    await publish(false).catch(() => undefined)
    set({ state: 'error', error: e instanceof InstallCancelled ? 'download cancelled' : e instanceof Error ? e.message : String(e) })
    throw e
  } finally {
    abort = null
  }
}

/** Remove runtimes of earlier versions (a new lock file installs next to the old one). */
async function prune(): Promise<void> {
  try {
    for (const n of await readdir(runtimeRoot())) {
      if (n !== RUNTIME_VERSION && n !== 'stub') await rm(join(runtimeRoot(), n), { recursive: true, force: true })
    }
  } catch {
    /* best effort */
  }
}
