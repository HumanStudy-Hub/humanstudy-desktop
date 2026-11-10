// A normal, editable protocol project, ready to inspect without an agent turn.
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const SAMPLE_TITLE = "Believing what you're told: Politeness and scalar inferences"
export const SAMPLE_ASSET_FILES = [
  'paper.pdf', 'protocol.json', 'study.json', 'sourcetext/paper.txt', 'README.md',
  'review/fidelity-review-1.md', 'review/resolutions-1.md', 'review/checks-latest.json', 'artifacts/preview.html',
] as const

/** Preflight every source and destination: never replace an existing researcher's file. */
export async function installSampleAssets(sourceDir: string, projectDir: string): Promise<void> {
  for (const name of SAMPLE_ASSET_FILES) {
    try { await readFile(join(sourceDir, name)) }
    catch { throw new Error(`Cannot create sample project: required sample asset is missing or unreadable: ${name} (from ${sourceDir})`) }
    try { await lstat(join(projectDir, name)) }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e }
    throw new Error(`Cannot install sample: destination already exists and will be preserved: ${join(projectDir, name)}`)
  }
  for (const name of SAMPLE_ASSET_FILES) {
    const to = join(projectDir, name)
    await mkdir(dirname(to), { recursive: true })
    await copyFile(join(sourceDir, name), to, constants.COPYFILE_EXCL)
  }
}
