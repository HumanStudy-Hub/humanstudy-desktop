// Managed agent kernel: when no opencode binary is installed, download the pinned release into
// userData/opencode/<version>/ (checked against SHA-256, resumable), unzip it and hand back the path.
// The pure parts (asset choice, download, checksum) live in opencode-install-core.ts.
import { app } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { KernelInstallStatus } from '../preload/types'
import { findOpencode } from './kernel/opencode'
import {
  InstallCancelled,
  OPENCODE_VERSION,
  assetUrl,
  binaryName,
  downloadVerified,
  percent,
  pickAsset,
} from './opencode-install-core'

const run = promisify(execFile)

const installDir = (): string => join(app.getPath('userData'), 'opencode', OPENCODE_VERSION)
const managedPath = (): string => join(installDir(), binaryName(process.platform))

/** The managed binary if it is already installed (sync, for createKernel). */
export function managedBinary(): string | null {
  const p = managedPath()
  return existsSync(p) && existsSync(join(installDir(), '.ok')) ? p : null
}

/** Whichever binary the kernel would use: managed first, then one the user installed. */
export function kernelBinary(): string | null {
  // HUMANSTUDY_IGNORE_SYSTEM_OPENCODE=1 forces the managed path (testing the first-run download).
  const managed = managedBinary()
  // The kernel factory reads this instead of importing this (electron-dependent) module.
  if (managed) process.env.HUMANSTUDY_OPENCODE_BIN = managed
  else delete process.env.HUMANSTUDY_OPENCODE_BIN
  return managed ?? (process.env.HUMANSTUDY_IGNORE_SYSTEM_OPENCODE ? null : findOpencode())
}

let status: KernelInstallStatus = { state: 'checking', version: OPENCODE_VERSION }
const listeners = new Set<(s: KernelInstallStatus) => void>()
function set(patch: Omit<KernelInstallStatus, 'version'>): void {
  status = { version: OPENCODE_VERSION, ...patch }
  for (const l of listeners) l(status)
}
export const installStatus = (): KernelInstallStatus => status
export function onInstallProgress(cb: (s: KernelInstallStatus) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** Bun's x64 build needs AVX2; without it opencode prints a warning, so use the -baseline zip.
 *  When detection fails the baseline build is chosen: it runs everywhere. */
async function hasAvx2(): Promise<boolean> {
  try {
    if (process.platform === 'darwin') {
      const { stdout } = await run('sysctl', ['-n', 'machdep.cpu.leaf7_features', 'machdep.cpu.features'])
      return /\bAVX2\b/.test(stdout)
    }
    if (process.platform === 'win32') {
      const script =
        "Add-Type -Namespace W -Name K -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern bool IsProcessorFeaturePresent(uint f);';" +
        '[W.K]::IsProcessorFeaturePresent(40)'
      const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true })
      return /true/i.test(stdout)
    }
  } catch {
    /* fall through */
  }
  return false
}

async function unzip(zip: string, into: string): Promise<void> {
  if (process.platform === 'win32') {
    const q = (s: string): string => `'${s.replace(/'/g, "''")}'`
    await run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath ${q(zip)} -DestinationPath ${q(into)} -Force`],
      { windowsHide: true }
    )
  } else {
    await run('unzip', ['-o', '-q', zip, '-d', into])
  }
}

let abort: AbortController | null = null
let inflight: Promise<string> | null = null

/** Cancel a running download (called on quit). The partial file is kept so the next run resumes it. */
export function cancelInstall(): void {
  abort?.abort()
}

/** Resolves to a usable opencode binary, downloading the pinned release when none is installed. */
export function ensureOpencode(onProgress?: (s: KernelInstallStatus) => void): Promise<string> {
  const off = onProgress ? onInstallProgress(onProgress) : undefined
  inflight ??= install().finally(() => {
    inflight = null
  })
  return inflight.finally(() => off?.())
}

async function install(): Promise<string> {
  const have = kernelBinary()
  if (have) {
    set({ state: 'ready', path: have })
    return have
  }
  try {
    set({ state: 'checking' })
    const asset = pickAsset(process.platform, process.arch, process.arch === 'x64' ? await hasAvx2() : true)
    if (!asset) throw new Error(`no opencode build for ${process.platform}-${process.arch}`)
    const dir = installDir()
    await mkdir(dir, { recursive: true })
    const zip = join(dir, asset.name)
    abort = new AbortController()
    set({ state: 'downloading', percent: 0 })
    let last = -1
    await downloadVerified({
      url: assetUrl(asset),
      dest: zip,
      size: asset.size,
      sha256: asset.sha256,
      signal: abort.signal,
      onProgress: (r, t) => {
        const p = percent(r, t)
        if (p !== last) {
          last = p
          set({ state: 'downloading', percent: p })
        }
      },
    })
    const tmp = join(dir, 'extract')
    await rm(tmp, { recursive: true, force: true })
    await mkdir(tmp, { recursive: true })
    await unzip(zip, tmp)
    const exe = binaryName(process.platform)
    const found = (await readdir(tmp)).find((n) => n === exe)
    if (!found) throw new Error(`${exe} not found in ${asset.name}`)
    const target = managedPath()
    await rm(target, { force: true })
    await rename(join(tmp, found), target)
    if (process.platform !== 'win32') await chmod(target, 0o755)
    await rm(tmp, { recursive: true, force: true })
    await rm(zip, { force: true })
    // Run it once: a wrong-architecture or blocked binary should fail here, not mid-conversation.
    const { stdout } = await run(target, ['--version'], { timeout: 20_000, windowsHide: true })
    if (!stdout.includes(OPENCODE_VERSION)) throw new Error(`unexpected opencode version: ${stdout.trim().slice(0, 80)}`)
    await writeFile(join(dir, '.ok'), OPENCODE_VERSION)
    set({ state: 'ready', percent: 100, path: target })
    return target
  } catch (e) {
    const msg = e instanceof InstallCancelled ? 'download cancelled' : e instanceof Error ? e.message : String(e)
    set({ state: 'error', error: msg })
    throw e
  } finally {
    abort = null
  }
}
