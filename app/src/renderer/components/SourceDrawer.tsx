import { useEffect, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { ProjectFile } from '../../preload/types'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export interface SourceRef {
  page: number
  quote?: string
  nodeId?: string
}

interface Props {
  pdf: ProjectFile | null
  source: SourceRef | null
  onClose(): void
}

export function SourceDrawer({ pdf, source, onClose }: Props) {
  const open = source !== null
  const pages = useRef<HTMLDivElement>(null)
  const [doc, setDoc] = useState<pdfjs.PDFDocumentProxy | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !pdf || doc) return
    const task = pdfjs.getDocument(pdf.url)
    task.promise.then(setDoc, (e: unknown) => setErr(String(e)))
  }, [open, pdf, doc])

  useEffect(() => setDoc(null), [pdf?.url])

  // Render every page once; canvases are cheap at drawer width.
  useEffect(() => {
    const host = pages.current
    if (!doc || !host) return
    host.replaceChildren()
    let cancelled = false
    void (async () => {
      for (let n = 1; n <= doc.numPages && !cancelled; n++) {
        const page = await doc.getPage(n)
        const base = page.getViewport({ scale: 1 })
        const scale = (host.clientWidth - 32) / base.width
        const vp = page.getViewport({ scale: scale * devicePixelRatio })
        const canvas = document.createElement('canvas')
        canvas.width = vp.width
        canvas.height = vp.height
        canvas.style.width = `${vp.width / devicePixelRatio}px`
        canvas.dataset.page = String(n)
        host.appendChild(canvas)
        await page.render({ canvasContext: canvas.getContext('2d')!, viewport: vp }).promise
      }
    })()
    return () => {
      cancelled = true
    }
  }, [doc])

  useEffect(() => {
    if (!source || !doc) return
    const t = setTimeout(() => {
      pages.current?.querySelector(`[data-page="${source.page}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 60)
    return () => clearTimeout(t)
  }, [source, doc])

  return (
    <aside className={`drawer ${open ? 'open' : ''}`} aria-hidden={!open}>
      <header className="drawer-head">
        <div>
          <div className="drawer-title">{pdf?.name ?? 'Source'}</div>
          {source && <div className="muted small">Page {source.page}{source.nodeId ? ` · cited by ${source.nodeId}` : ''}</div>}
        </div>
        <button className="ghost" onClick={onClose}>Close</button>
      </header>
      {source?.quote && <blockquote className="quote">“{source.quote}”</blockquote>}
      {!pdf && <p className="muted pad">This project has no paper.pdf.</p>}
      {err && <p className="part error pad">{err}</p>}
      <div className="pages" ref={pages} />
    </aside>
  )
}
