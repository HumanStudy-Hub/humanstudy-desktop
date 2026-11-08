import { useEffect, useState } from 'react'
import type { PaperBuildState } from '../../preload/types'
import { t } from '../i18n'
import { WEB_EDITION } from '../edition'

const STEPS = ['reading', 'writing', 'checking'] as const
const LONG_MIN = 25

/** Where a paper build is and how long it has run: the stages as a line of steps, the minutes so far
 *  against the usual time, and (in the full view) that the researcher need not watch it. */
export function BuildProgress({ build, full, waiting }: { build: PaperBuildState; full?: boolean; waiting?: boolean }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])
  const steps: string[] = build.phase === 'packaging' ? [...STEPS, 'packaging'] : [...STEPS]
  const at = build.status === 'pending' ? -1 : steps.indexOf(build.phase)
  const minutes = build.startedAt && build.status === 'running' ? Math.max(0, Math.floor((now - build.startedAt) / 60_000)) : null
  return (
    <div className={`build-progress${full ? ' full' : ''}`}>
      {/* Stage changes are announced; the minute counter is not. */}
      <ol className="build-steps" role="status" aria-live="polite">
        {steps.map((s, i) => (
          <li key={s} className={i < at ? 'done' : i === at ? 'current' : ''} aria-current={i === at ? 'step' : undefined}>
            {t(`build.step_${s}`)}
          </li>
        ))}
      </ol>
      {waiting && build.status === 'running' && <p className="small build-waiting" role="status">{t('build.waiting')}</p>}
      <p className="muted small" aria-live="off">
        {build.status === 'pending'
          ? t('build.pending')
          : minutes
            ? t(minutes >= LONG_MIN ? 'build.elapsed_long' : 'build.elapsed', { n: minutes })
            : t('build.usual')}
      </p>
      {full && !waiting && <p className="muted small">{t(WEB_EDITION ? 'build.leave_web' : 'build.leave')}</p>}
    </div>
  )
}
