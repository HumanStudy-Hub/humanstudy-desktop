// Compare and replace while holding the same lock as the agent's checkpoint helper. Exported apart
// from Electron so a real Python writer can be exercised against the exact app save path in tests.
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { withProgramLock } from './program-lock'

export async function saveProjectText(path: string, text: string, options: { ifUnchanged?: string; beforeWrite?: () => Promise<void> } = {}): Promise<void> {
  const program = basename(path).toLowerCase() === 'program.json'
  if (program) JSON.parse(text.replace(/^\uFEFF/, ''))
  await mkdir(dirname(path), { recursive: true })
  const save = async () => {
    if (options.ifUnchanged !== undefined && await readFile(path, 'utf8').catch(() => null) !== options.ifUnchanged)
      throw new Error('changed on disk while saving; try again')
    await options.beforeWrite?.()
    if (!program && options.ifUnchanged === undefined) return writeFile(path, text, 'utf8')
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
    try {
      const handle = await open(tmp, 'wx')
      try { await handle.writeFile(text, 'utf8'); await handle.sync() } finally { await handle.close() }
      for (let attempt = 0; ; attempt++) {
        try { await rename(tmp, path); break }
        catch (error) {
          if (!['EACCES', 'EPERM', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '') || attempt >= 9) throw error
          await new Promise((r) => setTimeout(r, 200))
        }
      }
    } finally { await unlink(tmp).catch(() => undefined) }
  }
  if (program) await withProgramLock(path, save)
  else await save()
}
