import { useEffect, useRef } from 'react'
import { t } from '../i18n'

/** One short, skippable introduction shown after creating the editable sample project. */
export function SampleOnboarding({ onClose }: { onClose(): void }) {
  const dialog = useRef<HTMLDivElement>(null)
  useEffect(() => {
    dialog.current?.focus()
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', keys)
    return () => window.removeEventListener('keydown', keys)
  }, [onClose])

  return (
    <div className="overlay sample-onboarding-overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="sample-onboarding" role="dialog" aria-modal="true" aria-labelledby="sample-guide-title" tabIndex={-1} ref={dialog}>
        <button className="ghost settings-close" onClick={onClose} aria-label={t('sampleGuide.skip')} title={t('sampleGuide.skip')}>×</button>
        <h2 id="sample-guide-title">{t('sampleGuide.title')}</h2>
        <p className="muted sample-guide-lead">{t('sampleGuide.intro')}</p>
        <ol className="sample-guide-steps">
          {[1, 2, 3, 4, 5].map((step) => <li key={step}>{t(`sampleGuide.step${step}`)}</li>)}
        </ol>
        <div className="row-end sample-guide-actions">
          <button className="ghost" onClick={onClose}>{t('sampleGuide.skip')}</button>
          <button className="primary" onClick={onClose}>{t('sampleGuide.done')}</button>
        </div>
      </div>
    </div>
  )
}
