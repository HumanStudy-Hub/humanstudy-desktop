// One file of the project: text is edited in place and saved back; HTML previews in a sandboxed
// frame; images show as images. Files the agent rewrites reload unless the researcher has unsaved
// edits, in which case a notice offers the reload.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProjectEntry } from '../../preload/types'
import { size } from './Explorer'
import { track } from '../telemetry'

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
  const [mode, setMode] = useState<'preview' | 'source'>(isHtml ? 'preview' : 'source')
  const [saved, setSaved] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [onDisk, setOnDisk] = useState<string | null>(null) // newer content while the editor is dirty
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [flash, setFlash] = useState('')
  const box = useRef<HTMLTextAreaElement>(null)
  const dirty = saved !== null && text !== saved

  useEffect(() => onDirty(file.path, dirty), [dirty, file.path, onDirty])

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
    void load().then((t) => {
      if (!live || t === null) return
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
      if (text === saved) {
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
      await window.humanstudy.project.writeText(file.path, text)
      setSaved(text)
      setOnDisk(null)
      setError('')
      setFlash('Saved')
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
        <img src={file.url} alt={file.name} />
      </div>
    )
  if (!isText)
    return (
      <div className="empty-state">
        <h2>{file.name}</h2>
        <p className="muted">
          {file.ext.toUpperCase()} file{file.size !== undefined ? ` · ${size(file.size)}` : ''}. It opens outside the app.
        </p>
        <button className="ghost" onClick={() => void window.humanstudy.project.reveal(file.path)}>
          Show in Finder
        </button>
      </div>
    )

  return (
    <div className="file-view">
      <div className="file-bar">
        <span className="file-path muted" title={file.path}>
          {file.rel}
        </span>
        {isHtml && (
          <div className="segmented mini" role="radiogroup" aria-label="View">
            <button role="radio" aria-checked={mode === 'preview'} onClick={() => setMode('preview')}>
              Preview
            </button>
            <button role="radio" aria-checked={mode === 'source'} onClick={() => setMode('source')}>
              Source
            </button>
          </div>
        )}
        {onDisk !== null && (
          <span className="file-notice">
            changed on disk ·{' '}
            <button
              className="link"
              onClick={() => {
                setSaved(onDisk)
                setText(onDisk)
                setOnDisk(null)
              }}
            >
              reload
            </button>
          </span>
        )}
        {flash && <span className="muted small">{flash}</span>}
        {mode === 'source' && (
          <button className={dirty ? 'primary small-btn' : 'ghost small-btn'} disabled={!dirty || saving} onClick={() => void save()} title="⌘S">
            {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
          </button>
        )}
      </div>
      {error && <div className="part error file-error">{error}</div>}
      {mode === 'preview' ? (
        <iframe className="artifact-frame" src={dirty ? `data:text/html;charset=utf-8,${encodeURIComponent(text)}` : file.url} sandbox="allow-scripts" title={file.name} />
      ) : saved === null && !error ? (
        <p className="muted pad">Loading…</p>
      ) : (
        <textarea
          ref={box}
          className="file-editor"
          value={text}
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
          aria-label={`Edit ${file.name}`}
        />
      )}
    </div>
  )
}
