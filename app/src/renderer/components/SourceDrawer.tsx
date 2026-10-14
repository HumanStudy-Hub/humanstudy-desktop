// The paper: every page drawn by pdf.js with a transparent layer of positioned words over it (the
// web build-preview source pane, lib/studio/pdf-client.ts + source-anchor.ts). A citation scrolls to
// its page and boxes the quoted words; when they are not on that page the miss is reported back, a
// real verification signal. Selecting text reports the passage so the Study view can show which
// items cite it, and offers to ask the agent about it.
import { useEffect, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { ProjectFile } from '../../preload/types'
import { findQuote, type Rect, type Word } from '../../shared/source-anchor'
import { makeWords } from './pdf-words'
import { lap, track } from '../telemetry'
import { t } from '../i18n'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export interface SourceRef {
  page: number
  quote?: string
  nodeId?: string
  sourceId?: string
  file?: string
  verified?: boolean
}
export type QuoteResult = { found: boolean; page?: number }
export type PassageSelection = { page: number; text: string }

interface Props {
  pdf: ProjectFile | null
  source: SourceRef | null
  closeLabel?: string
  onClose(): void
  onPageChange?(page: number): void
  /** Where the cited quote was found: its page, another page, or nowhere. */
  onQuote?(ref: SourceRef, result: QuoteResult): void
  /** The passage the reader selected; null once the selection is gone. */
  onSelect?(selection: PassageSelection | null): void
  /** How many study items cite the selected passage (null: not known). */
  supportCount?: number | null
  onAskPassage?(selection: PassageSelection): void
}

type PageInfo = { n: number; w: number; h: number; words: Word[] }
const MAX_TEXT_PAGES = 80

export function SourceDrawer({ pdf, source, onClose, onPageChange, closeLabel, onQuote, onSelect, supportCount, onAskPassage }: Props) {
  const open = source !== null
  const host = useRef<HTMLDivElement>(null)
  const [doc, setDoc] = useState<pdfjs.PDFDocumentProxy | null>(null)
  const [pages, setPages] = useState<PageInfo[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [hit, setHit] = useState<{ page: number; rects: Rect[] } | null>(null)
  const [verdict, setVerdict] = useState<QuoteResult | null>(null)
  const [selection, setSelection] = useState<(PassageSelection & { top: number; left: number }) | null>(null)

  useEffect(() => {
    setDoc(null)
    setPages([])
    setErr(null)
    if (!open || !pdf) return
    let live = true
    // Older papers often leave standard fonts unembedded; pdfjs needs its font data to draw their text.
    const base = new URL('pdfjs/', document.baseURI).href
    const task = pdfjs.getDocument({ url: pdf.url, standardFontDataUrl: `${base}standard_fonts/`, cMapUrl: `${base}cmaps/`, cMapPacked: true, useSystemFonts: false, isEvalSupported: false })
    task.promise.then(d => { if (live) setDoc(d) }, (e: unknown) => { if (live) setErr(String(e)) })
    return () => { live = false; void task.destroy() }
  }, [open, pdf?.url])

  // Page sizes and words first (cheap); canvases are drawn as pages come into view.
  useEffect(() => {
    if (!doc) return
    let cancelled = false
    const measure = document.createElement('canvas').getContext('2d')!
    void (async () => {
      const out: PageInfo[] = []
      for (let n = 1; n <= doc.numPages && !cancelled; n++) {
        const page = await doc.getPage(n)
        const vp = page.getViewport({ scale: 1 })
        let words: Word[] = []
        if (n <= MAX_TEXT_PAGES) {
          const content = await page.getTextContent()
          const items = content.items.filter((i): i is Extract<typeof i, { str: string }> => 'str' in i)
          words = makeWords(items, content.styles, vp, measure, pdfjs.Util.transform)
        }
        out.push({ n, w: vp.width, h: vp.height, words })
        // The first pages appear at once; the rest follow in one update.
        if (n === Math.min(2, doc.numPages) && !cancelled) setPages([...out])
      }
      if (!cancelled) setPages(out)
    })().catch(e => { if (!cancelled) setErr(String(e)) })
    return () => { cancelled = true }
  }, [doc])

  // The page in view: the one the app scrolled to, then whatever the reader scrolls to.
  const shown = useRef(0)
  const noteShown = (page: number, by: 'citation' | 'scroll') => {
    if (shown.current === page) return
    track('source.page', { target: `page.${page}`, durationMs: shown.current ? lap('source.page') : (lap('source.page'), undefined), metadata: { page, from: shown.current || null, by } })
    shown.current = page
    onPageChange?.(page)
  }
  useEffect(() => {
    const el = host.current
    if (!pages.length || !el || typeof IntersectionObserver === 'undefined') return
    const visible = new Map<Element, number>()
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) { if (e.isIntersecting) visible.set(e.target, e.intersectionRatio); else visible.delete(e.target) }
      const foremost = [...visible].sort((a, b) => b[1] - a[1])[0]
      if (foremost) noteShown(Number((foremost[0] as HTMLElement).dataset.page), 'scroll')
    }, { root: el, threshold: [0, 0.25, 0.5, 0.75, 1] })
    el.querySelectorAll('[data-page]').forEach(p => io.observe(p))
    return () => io.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages.length])

  // A citation: find the quote (cited page first), box it, scroll to it, report what was found.
  const reported = useRef<SourceRef | null>(null)
  useEffect(() => {
    if (!source) { shown.current = 0; setHit(null); setVerdict(null); return }
    if (!pages.length || pages.length < (doc?.numPages ?? 0)) {
      // Still reading: go to the cited page as soon as it exists.
      if (pages.some(p => p.n === source.page)) scrollTo(source.page)
      return
    }
    const quote = source.quote?.trim() ?? ''
    const found = quote ? findQuote(pages.map(p => ({ page: p.n, words: p.words })), quote, source.page) : null
    setHit(found)
    const result: QuoteResult | null = quote ? (found ? { found: true, page: found.page } : { found: false }) : null
    setVerdict(result)
    const page = found?.page ?? source.page
    scrollTo(page, found?.rects[0])
    noteShown(page, 'citation')
    if (result && reported.current !== source) {
      reported.current = source
      if (!result.found || result.page !== source.page) track('source.quote_check', { target: source.nodeId, metadata: { page: source.page, found: result.found, foundOn: result.page ?? null } })
      onQuote?.(source, result)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, pages])
  function scrollTo(page: number, rect?: Rect) {
    const el = host.current, target = el?.querySelector<HTMLElement>(`[data-page="${page}"]`)
    if (!el || !target) return
    const top = target.offsetTop + (rect ? rect.y / 100 * target.offsetHeight - el.clientHeight * 0.3 : -12)
    requestAnimationFrame(() => el.scrollTo({ top: Math.max(0, top), behavior: 'smooth' }))
  }

  function capture() {
    const el = host.current, sel = window.getSelection()
    if (!el || !sel || sel.isCollapsed || !sel.rangeCount || !el.contains(sel.anchorNode) || !el.contains(sel.focusNode)) {
      if (selection) { setSelection(null); onSelect?.(null) }
      return
    }
    const text = sel.toString().replace(/\s+/g, ' ').trim().slice(0, 2000)
    const anchor = sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement
    const page = Number(anchor?.closest<HTMLElement>('[data-page]')?.dataset.page)
    if (!text || !page) return
    const box = sel.getRangeAt(0).getBoundingClientRect(), base = el.getBoundingClientRect()
    const next = { page, text, top: box.top - base.top + el.scrollTop, left: Math.min(Math.max(8, box.left - base.left), Math.max(8, el.clientWidth - 260)) }
    setSelection(next)
    onSelect?.({ page, text })
    track('source.select', { target: `page.${page}`, metadata: { page, chars: text.length } })
  }

  const cited = source?.nodeId ? source : null
  return (
    <div className="source-body">
      {cited && <div className={`paper-cite ${verdict && (!verdict.found || verdict.page !== cited.page) ? 'warn' : ''}`} role="status">
        <span className="paper-cite-page">{t('doc.cite_page', { n: cited.page })}</span>
        {verdict && !verdict.found && <span>{t('model.quote_missing', { n: cited.page })}</span>}
        {verdict?.found && verdict.page !== cited.page && <span>{t('model.quote_moved', { n: cited.page, m: verdict.page ?? '' })}</span>}
        {cited.quote && (!verdict || !verdict.found) && <q>{cited.quote.length > 140 ? `${cited.quote.slice(0, 140)}…` : cited.quote}</q>}
        {!cited.quote && <span className="muted">{t('paper.page_only', { page: cited.page })}</span>}
        <button className="link" onClick={onClose}>{closeLabel ?? t('paper.back')}</button>
      </div>}
      {!pdf && <p className="muted pad">{source?.file || source?.sourceId ? t('paper.source_unavailable', { file: source.file ?? source.sourceId ?? '' }) : t('paper.none')}</p>}
      {err && <p className="part error pad">{err}</p>}
      <div className="pages" ref={host} onMouseUp={() => requestAnimationFrame(capture)} onKeyUp={capture}>
        {doc && pages.map(p => <PdfPage key={p.n} doc={doc} info={p} root={host} rects={hit?.page === p.n ? hit.rects : []} />)}
        {selection && onAskPassage && <div className="paper-ask" style={{ top: Math.max(0, selection.top - 40), left: selection.left }} onMouseDown={e => e.preventDefault()}>
          {supportCount != null && <span>{supportCount ? t('paper.cited_by', { n: supportCount }) : t('paper.cited_none')}</span>}
          <button onClick={() => { onAskPassage({ page: selection.page, text: selection.text }); window.getSelection()?.removeAllRanges(); setSelection(null) }}>{t('paper.ask')}</button>
        </div>}
      </div>
    </div>
  )
}

/** One page: the canvas (drawn once it is near the viewport), its words and the citation box. */
function PdfPage({ doc, info, root, rects }: { doc: pdfjs.PDFDocumentProxy; info: PageInfo; root: React.RefObject<HTMLDivElement | null>; rects: Rect[] }) {
  const el = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [near, setNear] = useState(false)
  useEffect(() => {
    if (!el.current || typeof IntersectionObserver === 'undefined') return setNear(true)
    const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { setNear(true); io.disconnect() } }, { root: root.current, rootMargin: '900px 0px' })
    io.observe(el.current)
    return () => io.disconnect()
  }, [root])
  useEffect(() => {
    if (!near || !canvas.current || !el.current) return
    let task: pdfjs.RenderTask | null = null, cancelled = false
    void doc.getPage(info.n).then(page => {
      if (cancelled || !canvas.current || !el.current) return
      const scale = Math.min(3, (el.current.clientWidth || 600) * devicePixelRatio / info.w)
      const vp = page.getViewport({ scale })
      canvas.current.width = Math.ceil(vp.width)
      canvas.current.height = Math.ceil(vp.height)
      task = page.render({ canvasContext: canvas.current.getContext('2d')!, viewport: vp })
      return task.promise
    }).catch(() => undefined)
    return () => { cancelled = true; task?.cancel() }
  }, [near, doc, info.n, info.w])
  const ratio = info.h / info.w
  return (
    <div ref={el} className="pdf-page" data-page={info.n} style={{ aspectRatio: `${info.w} / ${info.h}` }}>
      <canvas ref={canvas} aria-label={t('paper.page_aria', { n: info.n })} />
      {near && <div className="pdf-text">{info.words.map((w, i) => <span key={i} style={{ left: `${w.x}%`, top: `${w.y}%`, width: `${w.w}%`, height: `${w.h}%`, fontSize: `${w.h * ratio * 0.88}cqw` }}>{w.t} </span>)}</div>}
      {rects.map((r, i) => <div key={`${info.n}-${i}-${r.x}-${r.y}`} className="pdf-box" style={{ left: `${r.x}%`, top: `${r.y}%`, width: `${r.w}%`, height: `${r.h}%` }} />)}
    </div>
  )
}
