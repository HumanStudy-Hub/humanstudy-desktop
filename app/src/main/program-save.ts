// Compare and replace while holding the same lock as the agent's checkpoint helper. Exported apart
// from Electron so a real Python writer can be exercised against the exact app save path in tests.
import { randomUUID } from 'node:crypto'
import { copyFile, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { withProgramLock } from './program-lock'

export async function saveProjectText(path: string, text: string, options: { ifUnchanged?: string; beforeWrite?: () => Promise<void> } = {}): Promise<void> {
  const program = ['program.json', 'protocol.json'].includes(basename(path).toLowerCase())
  if (program) JSON.parse(text.replace(/^\uFEFF/, ''))
  await mkdir(dirname(path), { recursive: true })
  const save = async () => {
    if (options.ifUnchanged !== undefined && await readFile(path, 'utf8').catch(() => null) !== options.ifUnchanged)
      throw new Error('changed on disk while saving; try again')
    await options.beforeWrite?.()
    await replaceFile(path, async (tmp) => {
      const previous = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
        return null
      })
      if (previous && !previous.isFile()) throw Error('The save target is not a regular file.')
      const handle = await open(tmp, 'wx', previous ? previous.mode & 0o777 : 0o666)
      try { await handle.writeFile(text, 'utf8'); await handle.sync() } finally { await handle.close() }
    })
  }
  await withProgramLock(path, save)
}


/** Replace the directory entry, including when the previous target has other hard links. */
async function replaceFile(path: string, stage: (tmp: string) => Promise<void>): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await stage(tmp)
    for (let attempt = 0; ; attempt++) {
      try { await rename(tmp, path); break }
      catch (error) {
        if (!['EACCES', 'EPERM', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '') || attempt >= 9) throw error
        await new Promise((r) => setTimeout(r, 200))
      }
    }
  } finally { await unlink(tmp).catch(() => undefined) }
}

export function saveProjectCopy(source: string, path: string): Promise<void> {
  return replaceFile(path, (tmp) => copyFile(source, tmp, 1))
}
