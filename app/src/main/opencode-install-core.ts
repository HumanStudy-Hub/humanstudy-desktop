// Dependency-free core of the managed opencode download (no electron import), tested by
// opencode-install.test.mjs: asset choice, resumable download, SHA-256 verification.
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, rename, rm, stat } from 'node:fs/promises'

export const OPENCODE_VERSION = '1.18.21'
// github.com/sst/opencode redirects to anomalyco/opencode; the redirect is followed.
export const RELEASE_BASE = `https://github.com/sst/opencode/releases/download/v${OPENCODE_VERSION}`

export interface Asset {
  name: string
  size: number
  sha256: string
}

// The release publishes no checksum file, only per-asset digests in the GitHub API
// (GET /repos/sst/opencode/releases/tags/v1.18.21 -> assets[].digest). They are pinned here with
// the version, so a tampered download or a mutated release both fail verification.
const ASSETS: Record<string, Asset> = {
  'darwin-arm64': { name: 'opencode-darwin-arm64.zip', size: 46179582, sha256: '72f4b6029af185eb030995cfa062d038914e3142c9aa38f714fe56448e6e87d2' },
  'darwin-x64': { name: 'opencode-darwin-x64.zip', size: 48379227, sha256: '405559e5873a9131ff6bcafc413f46d4f199b4401f232d00bcd301d97ea7cdfc' },
  'darwin-x64-baseline': { name: 'opencode-darwin-x64-baseline.zip', size: 48379227, sha256: '13569e2d9850330922999ab9172145483b50e3f00c569a4d2315ab8d722d63d5' },
  'win32-x64': { name: 'opencode-windows-x64.zip', size: 60622013, sha256: 'f8cc5477f478fa129ece99b550d508363ceff612f99d859042e526b13b951542' },
  'win32-x64-baseline': { name: 'opencode-windows-x64-baseline.zip', size: 60622012, sha256: 'cffd857166a52c7ae36a337d6b42136910aaa534cf2b9d658c4ce71b903d12b8' },
  'win32-arm64': { name: 'opencode-windows-arm64.zip', size: 58781343, sha256: 'f0470c160152ee23175d3e489018a927e8eedc7de7832f71654b2bede1807637' },
}

/** The release asset for this machine, or null when there is no zip build (Linux ships tar.gz and is not a target). */
export function pickAsset(platform: string, arch: string, avx2: boolean): Asset | null {
  const base = `${platform}-${arch}`
  // Bun's x64 binary needs AVX2; opencode ships a -baseline build for CPUs without it.
  const key = arch === 'x64' && !avx2 ? `${base}-baseline` : base
  return ASSETS[key] ?? null
}

export const assetUrl = (a: Asset): string => `${RELEASE_BASE}/${a.name}`
export const binaryName = (platform: string): string => (platform === 'win32' ? 'opencode.exe' : 'opencode')

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(path)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')))
  })
}

export class InstallCancelled extends Error {
  constructor() {
    super('download cancelled')
  }
}

export interface DownloadOptions {
  url: string
  dest: string
  size: number
  sha256: string
  signal?: AbortSignal
  onProgress?: (received: number, total: number) => void
  fetchImpl?: typeof fetch
}

async function sizeOf(p: string): Promise<number> {
  try {
    return (await stat(p)).size
  } catch {
    return 0
  }
}

/** Downloads to `dest + '.part'` (resuming with a Range request when a partial file exists),
 *  verifies size and SHA-256, then renames to `dest`. A bad checksum discards the partial file and
 *  retries once from byte 0; a second failure throws. */
export async function downloadVerified(o: DownloadOptions): Promise<void> {
  const part = o.dest + '.part'
  for (let attempt = 0; attempt < 2; attempt++) {
    await fetchInto(o, part)
    const got = await sizeOf(part)
    if (got === o.size && (await sha256File(part)) === o.sha256) {
      await rename(part, o.dest)
      return
    }
    await rm(part, { force: true })
  }
  throw new Error('downloaded file failed its size / SHA-256 check twice')
}

async function fetchInto(o: DownloadOptions, part: string): Promise<void> {
  const f = o.fetchImpl ?? fetch
  let have = await sizeOf(part)
  if (have > o.size) {
    await rm(part, { force: true })
    have = 0
  }
  if (have === o.size) return // complete, verification decides
  const res = await f(o.url, { headers: have ? { range: `bytes=${have}-` } : {}, signal: o.signal })
  if (res.status === 416) {
    await rm(part, { force: true })
    return // next attempt restarts
  }
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`)
  // 200 means the server ignored Range: start over.
  const resumed = res.status === 206 && have > 0
  const fh = await open(part, resumed ? 'a' : 'w')
  let received = resumed ? have : 0
  try {
    const reader = res.body.getReader()
    for (;;) {
      if (o.signal?.aborted) throw new InstallCancelled()
      const { value, done } = await reader.read()
      if (done) break
      await fh.write(value)
      received += value.length
      o.onProgress?.(received, o.size)
    }
  } catch (e) {
    if (o.signal?.aborted) throw new InstallCancelled()
    throw e
  } finally {
    await fh.close()
  }
}

/** Percent 0-100 for a progress callback, never above 99 until verification is done. */
export const percent = (received: number, total: number): number =>
  total > 0 ? Math.min(99, Math.floor((received / total) * 100)) : 0
