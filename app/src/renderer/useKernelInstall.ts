import { useCallback, useEffect, useState } from 'react'
import type { KernelInstallStatus } from '../preload/types'

/** First-run download state of the agent kernel (opencode), with a retry after a failure. */
export function useKernelInstall(): { status: KernelInstallStatus | null; retry(): void } {
  const [status, setStatus] = useState<KernelInstallStatus | null>(null)
  useEffect(() => {
    const k = window.humanstudy.kernel.install
    let live = true
    k.status().then((s) => live && setStatus((prev) => prev ?? s)).catch(() => undefined)
    const off = k.onProgress((s) => live && setStatus(s))
    return () => {
      live = false
      off()
    }
  }, [])
  const retry = useCallback(() => {
    setStatus((s) => (s ? { ...s, state: 'checking', error: undefined } : s))
    void window.humanstudy.kernel.install.retry()
  }, [])
  return { status, retry }
}
