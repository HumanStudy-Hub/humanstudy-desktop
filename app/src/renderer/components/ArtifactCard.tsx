// An agent-made file as a card in the chat: human title, kind, version count and a small live preview.
import type { ProjectEntry } from '../../preload/types'
import { Markdown } from './Markdown'
import { CsvTable, useFileText, useVersions } from './Previews'
import { prettyJson, resultKind, resultTitle, type ResultKind } from '../results'
import { t } from '../i18n'

const KIND_ICON: Record<ResultKind, string> = {
  chart: '▦', figure: '◩', report: '≣', table: '▤', data: '{ }', simulation: '⟲', draft: '✎', document: '▭', file: '▫',
}

interface Props {
  entry: ProjectEntry
  onOpen(e: ProjectEntry): void
  /** Overrides the title (program.json is "the study document"). */
  title?: string
  /** Overrides the kind label. */
  kindLabel?: string
}

/** An inline card in a chat message: preview, human title, kind, version count. Click opens it on the right. */
export function ArtifactCard({ entry, onOpen, title: forcedTitle, kindLabel }: Props) {
  const kind = resultKind(entry.rel)
  const needsText = ['html', 'htm', 'md', 'markdown', 'txt', 'csv', 'tsv', 'json'].includes(entry.ext)
  const text = useFileText(entry, needsText)
  const versions = useVersions(entry)
  const title = forcedTitle ?? resultTitle(entry.rel, text ?? undefined)
  return (
    <button className="acard-inline" onClick={() => onOpen(entry)} title={t('artifact.open_named', { title })}>
      <span className="acard-thumb">
        <Thumb entry={entry} text={entry.rel === 'program.json' ? null : text} kind={kind} />
      </span>
      <span className="acard-info">
        <span className="acard-title">{title}</span>
        <span className="acard-sub">
          <span className="kind-pill" data-kind={kind}>{kindLabel ?? t('kind.' + kind)}</span>
          {versions.length > 1 && <span className="v-tag" title={t('artifact.versions', { n: versions.length })}>v{versions.length}</span>}
        </span>
      </span>
    </button>
  )
}

export function Thumb({ entry, text, kind }: { entry: ProjectEntry; text: string | null; kind: ResultKind }) {
  const ext = entry.ext
  if (ext === 'html' || ext === 'htm')
    return (
      <span className="thumb thumb-frame">
        <iframe key={entry.mtime ?? 0} src={entry.url} sandbox="allow-scripts" title={entry.name} tabIndex={-1} loading="lazy" />
      </span>
    )
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext))
    return (
      <span className="thumb thumb-img">
        <img key={entry.mtime ?? 0} src={entry.url} alt="" loading="lazy" />
      </span>
    )
  if (text !== null && (ext === 'md' || ext === 'markdown' || ext === 'txt'))
    return (
      <span className="thumb thumb-md">
        <Markdown text={text.slice(0, 900)} />
      </span>
    )
  if (text !== null && (ext === 'csv' || ext === 'tsv'))
    return (
      <span className="thumb thumb-csv">
        <CsvTable text={text} rows={6} cols={5} />
      </span>
    )
  if (text !== null && ext === 'json')
    return (
      <span className="thumb thumb-json">
        <pre>{prettyJson(text).split('\n').slice(0, 14).join('\n')}</pre>
      </span>
    )
  return (
    <span className="thumb thumb-icon" aria-hidden>
      <span className="thumb-glyph">{entry.rel === 'program.json' ? '▤' : KIND_ICON[kind]}</span>
      {entry.rel !== 'program.json' && <span className="thumb-ext">{ext.toUpperCase()}</span>}
    </span>
  )
}
