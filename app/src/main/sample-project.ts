import { copyFile, lstat, mkdir, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'

export const SAMPLE_ASSET_FILES = [
  'KNOBE.pdf',
  'experiment_1_harm.json',
  'experiment_1_help.json',
  'experiment_2_harm.json',
  'experiment_2_help.json',
  'README.md',
] as const

/** Install the original sample paper and benchmark materials into a new project. */
export async function installSampleAssets(sourceDir: string, projectDir: string): Promise<void> {
  for (const name of SAMPLE_ASSET_FILES) {
    try {
      await readFile(join(sourceDir, name))
    } catch {
      throw new Error(`Cannot create sample project: required sample asset is missing or unreadable: ${name} (from ${sourceDir})`)
    }
  }
  await mkdir(projectDir, { recursive: true })
  const destinations = ['KNOBE.pdf', 'paper.pdf', ...SAMPLE_ASSET_FILES.slice(1)].map((name) => join(projectDir, name))
  for (const destination of destinations) {
    try {
      await lstat(destination)
      throw new Error(`Cannot install sample: destination already exists and will be preserved: ${destination}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  await copyFile(join(sourceDir, 'KNOBE.pdf'), join(projectDir, 'KNOBE.pdf'), constants.COPYFILE_EXCL)
  await copyFile(join(sourceDir, 'KNOBE.pdf'), join(projectDir, 'paper.pdf'), constants.COPYFILE_EXCL)
  for (const name of SAMPLE_ASSET_FILES.slice(1)) {
    await copyFile(join(sourceDir, name), join(projectDir, name), constants.COPYFILE_EXCL)
  }
}
