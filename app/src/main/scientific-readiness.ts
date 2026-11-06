// Runs the build skill's checks (pack/skills/build/check_readiness.py) on one package, as the app's
// readiness gate. The checker is written fresh from the files bundled in the app into a private scratch
// folder for every run, so neither the project's editable copy nor an earlier written copy decides the
// result. Package code is never run here: check_readiness.py runs it only through sandbox_run.py.
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export interface ScientificProblem { check: string; reason: string }

/** Longer than check_readiness.py's own limits run one after another: check_package.py --no-validity
 *  (PACKAGE_TIMEOUT 700 s: the smoke tests and the recorded-answers check), check_validity's prompt capture (300 s)
 *  and analysis run (360 s), and the effects field check (300 s), with margin. */
export const SCIENTIFIC_TIMEOUT_MS = 40 * 60_000

export const RUNTIME_MISSING: ScientificProblem = { check: 'runtime', reason: 'The research runtime is not installed, so the build checks cannot run yet.' }
export const CHECKS_FAILED: ScientificProblem = { check: 'runtime', reason: 'The build checks could not complete. Retry; if it persists, reinstall the research runtime.' }

/** Parse the checker's single JSON line; anything else counts as a failed check, never as a pass. */
export function parseScientificReport(stdout: string): ScientificProblem[] {
  const report = JSON.parse(stdout.trim().split('\n').at(-1) ?? '')
  const problems = report?.problems
  if (!Array.isArray(problems) || problems.some((p: ScientificProblem) => typeof p?.check !== 'string' || typeof p?.reason !== 'string'))
    throw Error('Invalid scientific readiness report')
  return problems.slice(0, 30).map((p: ScientificProblem) => ({ check: p.check.slice(0, 40), reason: p.reason.slice(0, 400) }))
}

export async function scientificReadiness(python: string | null, files: [string, string][], project: string, slug: string, bin: string,
  timeout = SCIENTIFIC_TIMEOUT_MS): Promise<ScientificProblem[]> {
  if (!python) return [RUNTIME_MISSING]
  // Two separate folders: package code (confined by sandbox_run, which only confines files on macOS) works
  // under `home`, never in the folder that holds the checker.
  const work = await mkdtemp(join(tmpdir(), 'hs-readiness-'))
  const home = await mkdtemp(join(tmpdir(), 'hs-readiness-home-'))
  try {
    for (const [rel, content] of files) {
      const path = join(work, 'checks', ...rel.split('/'))
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, content, 'utf8')
    }
    const win = process.platform === 'win32'
    const system = win ? `${process.env.SystemRoot || 'C:\\Windows'}\\System32` : '/usr/bin:/bin:/usr/sbin:/sbin'
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(python, ['-I', '-B', '-X', 'utf8', join(work, 'checks', 'skills', 'build', 'check_readiness.py'), project, slug], {
        cwd: home, timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
        // No keys or tokens: only a path, a home and a temp folder in the scratch space.
        env: {
          PATH: (bin ? bin + (win ? ';' : ':') : '') + system,
          HOME: home, USERPROFILE: home, TMPDIR: home, TEMP: home, TMP: home, LANG: 'C.UTF-8',
          ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        },
      }, (error, output) => error ? reject(error) : resolve(output))
    })
    return parseScientificReport(stdout)
  } catch { return [CHECKS_FAILED] }
  finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined)
    await rm(home, { recursive: true, force: true }).catch(() => undefined)
  }
}
