// One file of the project: text is edited in place and saved back; HTML previews in a sandboxed
// frame; images show as images. Files the agent rewrites reload unless the researcher has unsaved
// edits, in which case a notice offers the reload. Unsaved text lives in drafts.ts, not only here, so
// switching tabs or views and coming back finds it again.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProjectEntry } from '../../preload/types'
import { size } from './Explorer'
import { track } from '../telemetry'
import { t } from '../i18n'
import { Markdown } from './Markdown'
import { CsvTable, useVersions } from './Previews'
import { copyText } from './Markdown'
import { resultTitle } from '../results'
import { listenToArtifact, withArtifactCsp } from '../bridge'
import { getDraft, isDirty, setDraft, toDisk } from '../drafts'
import { versionedUrl } from '../../shared/file-version'

const TEXT = new Set(['md', 'txt', 'json', 'py', 'html', 'htm', 'css', 'js', 'ts', 'mjs', 'csv', 'tsv', 'yaml', 'yml', 'r', 'sh', 'tex', 'bib', 'xml', 'toml', ''])
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'])

interface Props {
  file: ProjectEntry
  dir: string
  /** Changes whenever the project folder changed on disk. */
  version: unknown
  onDirty(path: string, dirty: boolean): void
}

export function FileView({ file, version, onDirty }: Props) {
  const isHtml = file.ext === 'html' || file.ext === 'htm'
  const isText = TEXT.has(file.ext)
  const isMd = file.ext === 'md' || file.ext === 'markdown'
  const isCsv = file.ext === 'csv' || file.ext === 'tsv'
  const hasPreview = isHtml || isMd || isCsv
  const [mode, setMode] = useState<'preview' | 'source'>(hasPreview ? 'preview' : 'source')
  // `saved` is the text on disk the editor is based on; a draft from an earlier visit restores both.
  const [saved, setSaved] = useState<string | null>(() => getDraft(file.path)?.base ?? null)
  const [text, setText] = useState(() => getDraft(file.path)?.text ?? '')
  const [onDisk, setOnDisk] = useState<string | null>(null) // newer content while the editor is dirty
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [flash, setFlash] = useState('')
  const box = useRef<HTMLTextAreaElement>(null)
  const versions = useVersions(file)
  const [viewing, setViewing] = useState<{ id: string; text: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const latest = versions[versions.length - 1]
  // Artifact views may ask the app to open a cited page or prefill the chat (see bridge.ts).
  const frame = useRef<HTMLIFrameElement>(null)
  useEffect(() => (isHtml ? listenToArtifact(() => frame.current) : undefined), [isHtml])

  const dirty = isDirty(text, saved)

  useEffect(() => onDirty(file.path, dirty), [dirty, file.path, onDirty])
  useEffect(() => {
    if (saved !== null) setDraft(file.path, text, saved)
  }, [file.path, text, saved])

  const load = useCallback(async () => {
    try {
      const t = await window.humanstudy.project.readText(file.path)
      setError('')
      return t
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return null
    }
  }, [file.path])

  useEffect(() => {
    if (!isText) return
    let live = true
    const draft = getDraft(file.path)
    void load().then((t) => {
      if (!live || t === null) return
      // A draft survives the visit; if the file changed on disk meanwhile, offer the reload.
      if (draft) return void (t !== draft.base && setOnDisk(t))
      setSaved(t)
      setText(t)
    })
    return () => {
      live = false
    }
  }, [load, isText])

  // The project changed on disk: pick up the new content unless there are unsaved edits.
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    if (!isText || saved === null) return
    let live = true
    void load().then((t) => {
      if (!live || t === null || t === saved) return
      if (!isDirty(text, saved)) {
        setSaved(t)
        setText(t)
      } else setOnDisk(t)
    })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version])

  const save = async () => {
    if (!dirty || saving) return
    setSaving(true)
    try {
      const disk = toDisk(text, onDisk ?? saved)
      await window.humanstudy.project.writeText(file.path, disk)
      setSaved(disk)
      setOnDisk(null)
      setError('')
      setFlash(t('file.saved'))
      setTimeout(() => setFlash(''), 1500)
      track('file.saved', { target: file.ext || 'file' })
    } catch (e) {
      setError((e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, ''))
    } finally {
      setSaving(false)
    }
  }

  if (IMAGE.has(file.ext))
    return (
      <div className="artifact-image">
        <img key={file.version ?? file.mtime ?? 0} src={file.url && versionedUrl(file.url, file.version)} alt={file.name} />
      </div>
    )
  if (!isText)
    return (
      <div className="empty-state">
        <h2>{file.name}</h2>
        <p className="muted">
          {t('file.outside', { ext: file.ext.toUpperCase() })}{file.size !== undefined ? ` · ${size(file.size)}` : ''}
        </p>
        <button className="ghost" onClick={() => void window.humanstudy.project.reveal(file.path)}>
          {t('file.reveal')}
        </button>
      </div>
    )

  return (
    <div className="file-view">
      <div className="file-bar">
        <span className="file-path" title={file.path}>
          {resultTitle(file.rel, saved ?? undefined)}
          <span className="muted small"> · {file.rel}</span>
        </span>
        {hasPreview && (
          <div className="segmented mini" role="radiogroup" aria-label={t('file.view')}>
            <button role="radio" aria-checked={mode === 'preview'} onClick={() => setMode('preview')}>
              {t('file.preview')}
            </button>
            <button role="radio" aria-checked={mode === 'source'} onClick={() => setMode('source')}>
              {t('file.edit')}
            </button>
          </div>
        )}
        {onDisk !== null && (
          <span className="file-notice">
            {t('file.changed')} ·{' '}
            <button
              className="link"
              onClick={() => {
                setSaved(onDisk)
                setText(onDisk)
                setOnDisk(null)
              }}
            >
              {t('file.reload')}
            </button>
          </span>
        )}
        {flash && <span className="muted small">{flash}</span>}
        {mode === 'source' && !viewing && saved !== null && (
          <button className={dirty ? 'primary small-btn' : 'ghost small-btn'} disabled={!dirty || saving} onClick={() => void save()} title="⌘S">
            {saving ? t('file.saving') : dirty ? t('file.save') : t('file.saved')}
          </button>
        )}
        <span className="file-tools">
          <button
            className="ghost small-btn"
            onClick={() => {
              void copyText(isText ? text : file.path)
              setCopied(true)
              window.setTimeout(() => setCopied(false), 1400)
              track('artifact.copy', { target: file.ext })
            }}
          >
            {copied ? t('chat.copied') : t('chat.copy')}
          </button>
          <button className="ghost small-btn" onClick={() => { track('artifact.download', { target: file.ext }); void window.humanstudy.project.saveCopy(file.path) }}>
            {t('file.download')}
          </button>
        </span>
      </div>
      {versions.length > 1 && (
        <div className="version-bar" role="group" aria-label={t('artifact.history')}>
          <span className="muted small">{t('artifact.history')}</span>
          {versions.map((v, i) => (
            <button
              key={v.id}
              className={`v-chip${(viewing ? viewing.id === v.id : v === latest) ? ' on' : ''}`}
              title={new Date(v.at).toLocaleString()}
              onClick={() => {
                if (v === latest) return setViewing(null)
                track('artifact.version_view', { target: file.ext, metadata: { index: i + 1 } })
                void window.humanstudy.project.readVersion(file.path, v.id).then((tx) => setViewing({ id: v.id, text: tx })).catch(() => undefined)
              }}
            >
              v{i + 1}
            </button>
          ))}
          {viewing && (
            <button className="link" onClick={() => setViewing(null)}>
              {t('artifact.back_latest')}
            </button>
          )}
        </div>
      )}
      {error && <div className="part error file-error">{error}</div>}
      {viewing ? (
        isMd ? (
          <div className="file-md"><Markdown text={viewing.text} /></div>
        ) : isHtml && mode === 'preview' ? (
          <iframe ref={frame} className="artifact-frame" src={`data:text/html;charset=utf-8,${encodeURIComponent(withArtifactCsp(viewing.text))}`} sandbox="allow-scripts" title={file.name} />
        ) : (
          <pre className="file-old">{viewing.text}</pre>
        )
      ) : mode === 'preview' && isMd ? (
        <div className="file-md">{saved === null ? <p className="muted">{t('common.loading')}</p> : <Markdown text={text} />}</div>
      ) : mode === 'preview' && isCsv ? (
        <div className="file-csv">{saved === null ? <p className="muted">{t('common.loading')}</p> : <CsvTable text={text} rows={200} cols={30} />}</div>
      ) : mode === 'preview' ? (
        <iframe ref={frame} key={file.version ?? file.mtime ?? 0} className="artifact-frame" src={dirty ? `data:text/html;charset=utf-8,${encodeURIComponent(withArtifactCsp(text))}` : file.url && versionedUrl(file.url, file.version)} sandbox="allow-scripts" title={file.name} />
      ) : saved === null && !error ? (
        <p className="muted pad">{t('common.loading')}</p>
      ) : (
        <textarea
          ref={box}
          className="file-editor"
          value={text}
          readOnly={saved === null}
          spellCheck={false}
          wrap="soft"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
              e.preventDefault()
              void save()
            }
            if (e.key === 'Tab') {
              e.preventDefault()
              const el = e.currentTarget
              const { selectionStart: a, selectionEnd: b } = el
              const next = text.slice(0, a) + '  ' + text.slice(b)
              setText(next)
              requestAnimationFrame(() => el.setSelectionRange(a + 2, a + 2))
            }
          }}
          aria-label={t('file.edit_named', { name: file.name })}
        />
      )}
    </div>
  )
}
