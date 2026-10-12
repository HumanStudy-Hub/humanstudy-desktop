// Dependency-free core of the managed opencode download (no electron import), tested by
// opencode-install.test.mjs: asset choice, resumable download, SHA-256 verification.
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, rename, rm, stat } from 'node:fs/promises'

// The HumanStudy edition of opencode (github.com/HumanStudy-Hub/opencode, see its HUMANSTUDY.md).
// KERNEL_TAG is the release tag, KERNEL_VERSION the upstream semver `opencode --version` reports
// (`opencode-humanstudy <semver>`); they differ for a second build such as hs-v1.18.21-2.
export const KERNEL_TAG = 'hs-v1.18.21'
export const KERNEL_VERSION = '1.18.21'
export const RELEASE_BASE = `https://github.com/HumanStudy-Hub/opencode/releases/download/${KERNEL_TAG}`
export const CHECKSUM_FILE = 'SHA256SUMS.txt'

export interface Asset {
  name: string
}

/** The release asset for this machine, or null when there is no zip build (Linux is not a target).
 *  Names are opencode-humanstudy-<darwin|windows>-<arch>[-baseline].zip; `platform` is Node's. */
export function pickAsset(platform: string, arch: string, avx2: boolean): Asset | null {
  const os = platform === 'darwin' ? 'darwin' : platform === 'win32' ? 'windows' : null
  if (!os) return null
  if (arch === 'arm64') return { name: `opencode-humanstudy-${os}-arm64.zip` }
  if (arch !== 'x64') return null
  // Bun's x64 binary needs AVX2; the release ships a -baseline build for CPUs without it.
  return { name: `opencode-humanstudy-${os}-x64${avx2 ? '' : '-baseline'}.zip` }
}

export const assetUrl = (a: Asset, base: string = RELEASE_BASE): string => `${base}/${a.name}`
export const binaryName = (platform: string): string => (platform === 'win32' ? 'opencode.exe' : 'opencode')

/** The SHA-256 for `name` from a `sha256sum`-format file ("<hex>  <name>" or "<hex> *<name>"), or null. */
export function parseChecksum(text: string, name: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(\S.*?)\s*$/.exec(line)
    if (m && m[2].replace(/^\.?\//, '') === name) return m[1].toLowerCase()
  }
  return null
}

/** Downloads SHA256SUMS.txt from the release and returns the digest listed for `name`. */
export async function fetchChecksum(
  name: string,
  o: { base?: string; fetchImpl?: typeof fetch; signal?: AbortSignal } = {}
): Promise<string> {
  const f = o.fetchImpl ?? fetch
  const res = await f(`${o.base ?? RELEASE_BASE}/${CHECKSUM_FILE}`, { signal: o.signal })
  if (!res.ok) throw new Error(`could not fetch ${CHECKSUM_FILE}: HTTP ${res.status}`)
  const sha = parseChecksum(await res.text(), name)
  if (!sha) throw new Error(`${CHECKSUM_FILE} has no entry for ${name}`)
  return sha
}

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
  /** Expected size; when omitted it is taken from the response's Content-Length. */
  size?: number
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
  let total = o.size
  for (let attempt = 0; attempt < 2; attempt++) {
    // A finished download that was not renamed yet (crash, or the size is unknown): accept it by digest.
    if ((await sizeOf(part)) > 0 && (await sha256File(part)) === o.sha256) {
      await rename(part, o.dest)
      return
    }
    total = (await fetchInto(o, part, total)) ?? total
    const got = await sizeOf(part)
    if ((total === undefined || got === total) && (await sha256File(part)) === o.sha256) {
      await rename(part, o.dest)
      return
    }
    await rm(part, { force: true })
  }
  throw new Error('downloaded file failed its size / SHA-256 check twice')
}

/** Returns the total size when the server told us (or we were given it). */
async function fetchInto(o: DownloadOptions, part: string, known: number | undefined): Promise<number | undefined> {
  const f = o.fetchImpl ?? fetch
  let have = await sizeOf(part)
  if (known !== undefined && have > known) {
    await rm(part, { force: true })
    have = 0
  }
  if (known !== undefined && have === known) return known // complete, verification decides
  const res = await f(o.url, { headers: have ? { range: `bytes=${have}-` } : {}, signal: o.signal })
  if (res.status === 416) {
    await rm(part, { force: true })
    return known // next attempt restarts
  }
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`)
  // 200 means the server ignored Range: start over.
  const resumed = res.status === 206 && have > 0
  const len = Number(res.headers.get('content-length'))
  const total = known ?? (len > 0 ? (resumed ? have + len : len) : undefined)
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
      o.onProgress?.(received, total ?? 0)
    }
  } catch (e) {
    if (o.signal?.aborted) throw new InstallCancelled()
    throw e
  } finally {
    await fh.close()
  }
  return total
}

/** Percent 0-100 for a progress callback, never above 99 until verification is done. */
export const percent = (received: number, total: number): number =>
  total > 0 ? Math.min(99, Math.floor((received / total) * 100)) : 0
