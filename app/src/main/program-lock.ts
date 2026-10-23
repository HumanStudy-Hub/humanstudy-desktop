// Shared with program_lock.py: an atomic directory plus a uniquely named owner file. Never remove
// recursively: competing crash recovery cannot delete a newly acquired writer's lock.
import { mkdir, readdir, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH' }
}
export async function withProgramLock<T>(target: string, work: () => Promise<T>, timeout = 15_000): Promise<T> {
  const lock = target + '.lock'
  const owner = `${process.pid}-${randomUUID()}`
  const until = Date.now() + timeout
  for (;;) {
    try {
      await mkdir(lock)
      try { await writeFile(join(lock, owner), '', { flag: 'wx' }) }
      catch (error) { await rmdir(lock).catch(() => undefined); throw error }
      break
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      // Windows: a lock folder another writer just removed is "delete pending" while a handle is open,
      // and mkdir fails with EPERM/EACCES. That is a busy lock (same rule as program_lock.py).
      if (process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES')) {
        if (Date.now() >= until) throw error
        await new Promise((r) => setTimeout(r, 25))
        continue
      }
      if (code !== 'EEXIST') throw error
      const entries = await readdir(lock).catch(() => null)
      if (entries?.length === 1 && /^\d+-[\da-f-]+$/.test(entries[0]!) && !alive(Number(entries[0]!.split('-')[0]))) {
        // Only the reaper that actually unlinks the old token may remove the empty directory.
        try { await unlink(join(lock, entries[0]!)); await rmdir(lock) } catch { /* another writer/reaper won */ }
      } else if (entries?.length === 0 && Date.now() - ((await stat(lock).catch(() => null))?.mtimeMs ?? Date.now()) > 30_000) {
        await rmdir(lock).catch(() => undefined) // crashed between mkdir and owner creation
      }
      if (Date.now() >= until) throw new Error('Another program save is still in progress. Your changes were kept; try saving again.')
      await new Promise((r) => setTimeout(r, 25))
    }
  }
  try { return await work() }
  finally { await unlink(join(lock, owner)).catch(() => undefined); await rmdir(lock).catch(() => undefined) }
}
