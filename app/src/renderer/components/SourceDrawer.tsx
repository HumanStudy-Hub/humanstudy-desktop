import { useEffect, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { ProjectFile } from '../../preload/types'
import { lap, track } from '../telemetry'
import { t } from '../i18n'

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
    // Older papers often leave standard fonts unembedded; pdfjs needs its font data to draw their text.
    const base = new URL('pdfjs/', document.baseURI).href
    const task = pdfjs.getDocument({ url: pdf.url, standardFontDataUrl: `${base}standard_fonts/`, cMapUrl: `${base}cmaps/`, cMapPacked: true, useSystemFonts: false })
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

  // The page in view: the one the app scrolled to, then whatever the reader scrolls to.
  const shown = useRef(0)
  const noteShown = (page: number, by: 'citation' | 'scroll') => {
    if (shown.current === page) return
    track('source.page', { target: `page.${page}`, durationMs: shown.current ? lap('source.page') : (lap('source.page'), undefined), metadata: { page, from: shown.current || null, by } })
    shown.current = page
  }
  useEffect(() => {
    if (!source) {
      shown.current = 0
      return
    }
    if (doc) noteShown(source.page, 'citation')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, doc])
  useEffect(() => {
    const host = pages.current
    if (!doc || !host || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting && e.intersectionRatio >= 0.5) noteShown(Number((e.target as HTMLElement).dataset.page), 'scroll')
      },
      { threshold: 0.5 },
    )
    const mo = new MutationObserver(() => host.querySelectorAll('canvas[data-page]').forEach((c) => io.observe(c)))
    mo.observe(host, { childList: true })
    host.querySelectorAll('canvas[data-page]').forEach((c) => io.observe(c))
    return () => {
      io.disconnect()
      mo.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc])

  useEffect(() => {
    if (!source || !doc) return
    const t = setTimeout(() => {
      pages.current?.querySelector(`[data-page="${source.page}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 60)
    return () => clearTimeout(t)
  }, [source, doc])

  return (
    <div className="source-body">
      {source?.nodeId && <div className="muted small pad source-cite">{t('paper.cited', { page: source.page, id: source.nodeId })} <button className="link" onClick={onClose}>{t('paper.back')}</button></div>}
      {source?.quote && <blockquote className="quote">“{source.quote}”</blockquote>}
      {!pdf && <p className="muted pad">{t('paper.none')}</p>}
      {err && <p className="part error pad">{err}</p>}
      <div className="pages" ref={pages} />
    </div>
  )
}
