// An inline card for a tool permission the agent is waiting on (opencode `permission.asked`).
import { useState, type ReactNode } from 'react'
import type { PermissionReply } from '../../preload/types'
import type { PermissionPart } from '../useSession'
import { t } from '../i18n'

const ICONS: Record<string, ReactNode> = {
  bash: <path d="M2.5 4l4 3.5-4 3.5M8 12h5.5" />,
  file: <path d="M4 1.8h5l3 3v9.4H4zM9 1.8v3h3" />,
  globe: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M2 8h12M8 2c2 1.6 2.8 3.6 2.8 6S10 12.4 8 14C6 12.4 5.2 10.4 5.2 8S6 3.6 8 2z" />
    </>
  ),
  folder: <path d="M1.8 4.2h4.2l1.4 1.6h6.8v6.6H1.8z" />,
  key: <path d="M8 2l5 2v4c0 3-2.2 5-5 6-2.8-1-5-3-5-6V4z" />,
}
const iconFor = (type: string) =>
  type === 'bash' ? 'bash' : type === 'edit' || type === 'write' ? 'file' : type === 'webfetch' ? 'globe' : type === 'external_directory' ? 'folder' : 'key'

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)

/** What is being asked for: the command, file path or URL. */
export function permissionTarget(p: PermissionPart): string {
  const m = p.metadata ?? {}
  return p.title || str(m.command) || str(m.filepath) || str(m.url) || str(m.path) || p.type
}
const verbKeys: Record<string, string> = {
  bash: 'perm.bash',
  edit: 'perm.edit',
  write: 'perm.write',
  webfetch: 'perm.webfetch',
  external_directory: 'perm.external',
}

export function PermissionCard({ part, onReply }: { part: PermissionPart; onReply(id: string, response: PermissionReply): void }) {
  const [showDiff, setShowDiff] = useState(true)
  if (part.automatic) return null
  const target = permissionTarget(part)
  const diff = str(part.metadata?.diff)

  if (part.resolved || part.expired) {
    const label = t(part.expired ? 'perm.expired' : part.resolved === 'once' ? 'perm.done_once' : part.resolved === 'always' ? 'perm.done_always' : 'perm.done_denied')
    return (
      <div className={`perm done ${part.resolved === 'reject' ? 'denied' : ''}`} role="status">
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden className="perm-icon">
          {part.resolved === 'reject' ? <path d="M4 4l8 8M12 4l-8 8" /> : part.expired ? <path d="M3 8h10" /> : <path d="M3 8.5l3.2 3.2L13 4.5" />}
        </svg>
        <span className="perm-label">{label}</span>
        <span className="perm-dot" aria-hidden>·</span>
        <span className="perm-target" title={target}>{target}</span>
      </div>
    )
  }

  const reply = (r: PermissionReply) => onReply(part.id, r)
  return (
    <div
      className="perm pending"
      role="group"
      aria-label={t('perm.aria')}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          e.stopPropagation()
          reply('once')
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          reply('reject')
        }
      }}
    >
      <div className="perm-head">
        <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden className="perm-icon">
          {ICONS[iconFor(part.type)]}
        </svg>
        <div className="perm-what">
          <div className="perm-verb">{verbKeys[part.type] ? t(verbKeys[part.type]) : t('perm.other', { type: part.type })}</div>
          <code className="perm-title" title={target}>{target}</code>
        </div>
      </div>
      {diff && (
        <div className="perm-diff-wrap">
          <button className="link" onClick={() => setShowDiff(!showDiff)} aria-expanded={showDiff}>
            {t(showDiff ? 'perm.hide_changes' : 'perm.show_changes')}
          </button>
          {showDiff && <DiffBlock text={diff} />}
        </div>
      )}
      <div className="perm-actions">
        <button className="primary" onClick={() => reply('once')} title={t('perm.once_hint')}>{t('perm.once')}</button>
        <button className="ghost" onClick={() => reply('always')}>{t('perm.always')}</button>
        <button className="ghost deny" onClick={() => reply('reject')} title={t('perm.deny_hint')}>{t('perm.deny')}</button>
      </div>
    </div>
  )
}

/** A unified diff, + lines green and - lines red. */
export function DiffBlock({ text }: { text: string }) {
  return (
    <pre className="diff">
      {text.replace(/\n$/, '').split('\n').map((line, i) => (
        <span key={i} className={diffClass(line)}>
          {line || ' '}
          {'\n'}
        </span>
      ))}
    </pre>
  )
}
const diffClass = (l: string) =>
  l.startsWith('+++') || l.startsWith('---') ? 'dl file' : l.startsWith('@@') ? 'dl hunk' : l.startsWith('+') ? 'dl add' : l.startsWith('-') ? 'dl del' : 'dl'

/** True when the text looks like a unified diff. */
export function isDiff(text: string | undefined): boolean {
  if (!text) return false
  const lines = text.split('\n')
  return lines.some((l) => l.startsWith('@@')) || (lines.some((l) => l.startsWith('--- ')) && lines.some((l) => l.startsWith('+++ ')))
}
