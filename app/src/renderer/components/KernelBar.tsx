import type { KernelInstallStatus } from '../../preload/types'

/** First-run download of the agent kernel: a progress line, or the error with Retry. Nothing otherwise. */
export function KernelBar({ kernel }: { kernel: { status: KernelInstallStatus | null; retry(): void } }) {
  const s = kernel.status
  if (!s || (s.state !== 'downloading' && s.state !== 'error')) return null
  return (
    <div className={`kernel-bar ${s.state}`} role="status">
      {s.state === 'downloading' ? (
        <>
          <span>Setting up the assistant…{s.percent != null ? ` ${Math.round(s.percent)}%` : ''}</span>
          <div className="kernel-track" aria-hidden>
            <span style={{ width: `${s.percent ?? 0}%` }} />
          </div>
        </>
      ) : (
        <div className="kernel-error">
          <span title={s.error}>The assistant could not be set up{s.error ? `: ${s.error}` : '.'}</span>
          <button className="link" onClick={kernel.retry}>Retry</button>
        </div>
      )}
    </div>
  )
}
