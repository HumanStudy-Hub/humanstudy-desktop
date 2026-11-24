import { useEffect, useState } from 'react'
import './updates.css'
import { t } from '../i18n'
import { deadlineNotice, sessionDeadline } from '../session-deadline'

// Read once, when the page loads; the server's figure is the time left at that moment.
const DEADLINE = typeof window === 'undefined' ? null
  : sessionDeadline((window as unknown as { __HS_WEB__?: { deadlineIn?: unknown } }).__HS_WEB__?.deadlineIn)

/** Online workspaces only: a quiet "ends in N min" in the last 10 minutes, a clear notice in the last 2. */
export function SessionDeadline() {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (DEADLINE === null) return
    const timer = setInterval(() => setNow(Date.now()), 5_000)
    return () => clearInterval(timer)
  }, [])
  const notice = DEADLINE === null ? null : deadlineNotice(DEADLINE - now)
  if (!notice) return null
  return notice.final ? (
    <div className="update-notice session-deadline final" role="alert">
      <span className="update-dot" aria-hidden />
      <span>{t('session.ending')}</span>
    </div>
  ) : (
    <div className="update-notice session-deadline" role="status">
      <span className="update-dot" aria-hidden />
      <span>{t('session.ends_in', { n: notice.minutes })}</span>
    </div>
  )
}
