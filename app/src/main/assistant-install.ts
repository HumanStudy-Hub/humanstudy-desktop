// One install for the assistant: the agent kernel (opencode-install.ts) and the research runtime
// (runtime-install.ts) run in parallel and report as one KernelInstallStatus stream, so the renderer's
// "Setting up the assistant… 42%" bar covers both. `phase` says which part is currently the slow one.
import type { KernelInstallStatus } from '../preload/types'
import { cancelInstall, ensureOpencode, installStatus as kernelStatus, onInstallProgress as onKernel } from './opencode-install'
import { type PartStatus, combineInstall } from './runtime-core'
import { RUNTIME_VERSION, cancelRuntimeInstall, ensureRuntime, onRuntimeProgress, runtimeStatus } from './runtime-install'

let last: KernelInstallStatus | null = null
const listeners = new Set<(s: KernelInstallStatus) => void>()

function merged(): KernelInstallStatus {
  const k = kernelStatus()
  const kp: PartStatus = { state: k.state, percent: k.percent, error: k.error }
  const c = combineInstall(kp, runtimeStatus())
  return {
    version: k.version,
    state: c.state,
    ...(c.percent != null ? { percent: c.percent } : {}),
    ...(c.error ? { error: c.error } : {}),
    ...(c.phase ? { phase: c.phase } : {}),
    ...(k.path ? { path: k.path } : {}),
    runtimeVersion: RUNTIME_VERSION,
  }
}

function emit(): void {
  const s = merged()
  if (last && JSON.stringify(last) === JSON.stringify(s)) return
  last = s
  for (const l of listeners) l(s)
}
onKernel(emit)
onRuntimeProgress(emit)

export const installStatus = (): KernelInstallStatus => merged()
export function onInstallProgress(cb: (s: KernelInstallStatus) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export const cancelAssistantInstall = (): void => {
  cancelInstall()
  cancelRuntimeInstall()
}

/** Installs whatever is missing of kernel + runtime. Rejects with the first error after both have finished,
 *  so one failing part never leaves the other half-downloaded in the background. */
export async function ensureAssistant(): Promise<void> {
  const r = await Promise.allSettled([ensureOpencode(), ensureRuntime()])
  const bad = r.find((x): x is PromiseRejectedResult => x.status === 'rejected')
  if (bad) throw bad.reason
}
