import { gzipSync } from 'node:zlib'

/** Keep Storage requests small without cutting any bytes from the scientific content. */
export function storeResearchContent(text: string, write: (bytes: Uint8Array) => string | null): string | null {
  const raw = Buffer.from(text, 'utf8')
  const partBytes = 4 * 1024 * 1024
  if (raw.length <= partBytes) return write(new Uint8Array(gzipSync(raw)))
  const parts: string[] = []
  for (let start = 0; start < raw.length; start += partBytes) {
    const part = write(new Uint8Array(gzipSync(raw.subarray(start, start + partBytes))))
    if (!part) throw new Error('Could not persist complete research content')
    parts.push(part)
  }
  return write(new Uint8Array(gzipSync(Buffer.from(JSON.stringify({ format: 'humanstudy-content-parts-v1', encoding: 'utf8', bytes: raw.length, parts })))))
}
