// Pure Node runner: only the app's bundled checker and managed interpreter are accepted by callers.
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
export interface ScientificProblem { check: string; reason: string }
export async function scientificReadiness(python: string | null, checker: string, project: string, slug: string, bin: string): Promise<ScientificProblem[]> {
  if (!python) return [{ check: 'runtime', reason: 'The research runtime is unavailable. Install it before validating this package.' }]
  const work = await mkdtemp(join(tmpdir(), 'hs-readiness-'))
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(python, ['-I', '-B', checker, project, slug], {
        cwd: work, timeout: 150_000, maxBuffer: 1024 * 1024,
        env: { PATH: bin + (process.platform === 'win32' ? ';' : ':') + (process.platform === 'win32' ? `${process.env.SystemRoot || 'C:\\Windows'}\\System32` : '/usr/bin:/bin'),
          HOME: work, USERPROFILE: work, TMPDIR: work, TEMP: work, TMP: work, LANG: 'C.UTF-8',
          ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
      }, (error, output) => error ? reject(error) : resolve(output))
    })
    const report = JSON.parse(stdout)
    if (!Array.isArray(report.problems) || report.problems.some((p: ScientificProblem) => typeof p?.check !== 'string' || typeof p?.reason !== 'string')) throw Error('Invalid scientific result')
    return report.problems.slice(0, 30)
  } catch { return [{ check: 'runtime', reason: 'Scientific checks could not complete. Check the research runtime and retry.' }] }
  finally { await rm(work, { recursive: true, force: true }) }
}
