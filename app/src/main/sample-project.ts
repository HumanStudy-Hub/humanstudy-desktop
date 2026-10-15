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

/** A real simulation run of the sample (Haiku 5.5, 20 AI participants per condition), so a first-time user
 *  sees a finished result in the Simulation tab before spending anything. Same folder name as
 *  EXAMPLE_RUN in shared/simulation-run.ts; its summary.json carries "example": true. */
export const SAMPLE_EXAMPLE_RUN = 'artifacts/simulations/2026-10-15-1329-example'
export const SAMPLE_EXAMPLE_FILES = ['results.html', 'summary.json', 'progress.json', 'report.md'] as const

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
  // The example run is optional: a build without it still makes a complete sample project.
  const example = join(projectDir, ...SAMPLE_EXAMPLE_RUN.split('/'))
  for (const name of SAMPLE_EXAMPLE_FILES) {
    const from = join(sourceDir, 'example-simulation', name)
    try { await readFile(from) } catch { continue }
    await mkdir(example, { recursive: true })
    await copyFile(from, join(example, name), constants.COPYFILE_EXCL).catch(() => undefined)
  }
}
