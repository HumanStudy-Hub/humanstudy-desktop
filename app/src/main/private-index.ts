// Loads the research-capture redaction index the original-wording helper writes (pack/runtime/lib/hs_original_text.py):
// <userData>/original-text/redact/<sha256 of a project folder>.v<INDEX_FORMAT>.bin (sorted 8-byte hashes, never text)
// beside <sha>.path (the folder). Kept free of Electron so it can be tested directly.
import { existsSync } from 'node:fs'
import { readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { INDEX_FORMAT, mergePrivateIndex, type PrivateIndex } from './telemetry-core'

/** The merged index of every current-format file in `dir`. An index of an older format is deleted (the helper
 *  rebuilds it on the project's next check); so is the index of a project folder that no longer exists. */
export async function loadPrivateIndexDir(dir: string): Promise<PrivateIndex> {
  const buffers: Uint8Array[] = []
  const current = `.v${INDEX_FORMAT}.bin`
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!name.endsWith('.bin')) continue
    if (!name.endsWith(current)) { await rm(join(dir, name), { force: true }).catch(() => undefined); continue }
    const pathFile = join(dir, name.slice(0, -current.length) + '.path')
    const folder = await readFile(pathFile, 'utf8').catch(() => null)
    if (folder !== null && !existsSync(folder.trim())) {
      await Promise.all([rm(join(dir, name), { force: true }), rm(pathFile, { force: true })]).catch(() => undefined)
      continue
    }
    const b = await readFile(join(dir, name)).catch(() => null)
    if (b) buffers.push(b)
  }
  return mergePrivateIndex(buffers)   // each file is already sorted: merged, never re-sorted
}
