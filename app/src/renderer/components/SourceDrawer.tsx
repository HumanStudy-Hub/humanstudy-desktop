// The paper: every page drawn by pdf.js with a transparent layer of positioned words over it (the
// web build-preview source pane, lib/studio/pdf-client.ts + source-anchor.ts). A citation scrolls to
// its page and boxes the quoted words; when they are not on that page the miss is reported back, a
// real verification signal. Selecting text reports the passage so the Study view can show which
// items cite it, and offers to ask the agent about it.
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { createPageCache } from '../pdf-page-cache'
import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { ProjectFile } from '../../preload/types'
import { findQuote, type Rect, type Word } from '../../shared/source-anchor'
import type { TokenDiff, TokenPart } from '../../shared/significant-tokens'
import { readPdfAnnotations, type PdfAnnotation } from '../../shared/pdf-annotations'
import { observeSettledWidth } from '../settled-width'
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
/** Where a cited quote was located. Located is a text match only: `differs` lists numbers or signs
 * that do not match exactly, and nothing here says the citation was checked by a person. */
export type QuoteResult = { found: boolean; page?: number; differs?: TokenDiff }
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
  active?: boolean
  supportCount?: number | null
  onAskPassage?(selection: PassageSelection): void
}

type PageInfo = { n: number; w: number; h: number; words: Word[] }

export function SourceDrawer({
  pdf,
  source,
  onClose,
  onPageChange,
  closeLabel,
  onQuote,
  onSelect,
  supportCount,
  onAskPassage,
  active = true,
}: Props) {
  const open = source !== null
  const [selecting, setSelecting] = useState(false)
  const callbacks = useRef({ onQuote, onPageChange })
  callbacks.current = { onQuote, onPageChange }
  const host = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(1)
  const [annotations, setAnnotations] = useState<PdfAnnotation[]>([])
  const [annotationError, setAnnotationError] = useState('')
  const [annotationsReady, setAnnotationsReady] = useState(false)
  const [saving, setSaving] = useState(false)
  const annotationRaw = useRef<string | null>(null)
  const [doc, setDoc] = useState<pdfjs.PDFDocumentProxy | null>(null)
  const [pages, setPages] = useState<PageInfo[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [hit, setHit] = useState<{ page: number; rects: Rect[] } | null>(null)
  const [verdict, setVerdict] = useState<QuoteResult | null>(null)
  const [selection, setSelection] = useState<
    (PassageSelection & { top: number; left: number; pages: PdfAnnotation['pages']; annotationId?: string }) | null
  >(null)

  useEffect(() => {
    let live = true
    setAnnotations([])
    setAnnotationsReady(false)
    setAnnotationError('')
    setSelection(null)
    setZoom(1)
    annotationRaw.current = null
    if (!pdf) return
    void window.humanstudy.project
      .readText(`${pdf.path}.annotations.json`)
      .then((raw) => {
        const parsed = readPdfAnnotations(raw)
        if (live) {
          annotationRaw.current = raw
          setAnnotations(parsed.annotations)
          setAnnotationsReady(true)
        }
      })
      .catch((e) => {
        if (!live) return
        if (/ENOENT|no such file/i.test(String(e))) setAnnotationsReady(true)
        else setAnnotationError(String(e))
      })
    return () => {
      live = false
    }
  }, [pdf?.path])

  async function saveAnnotation(remove = false) {
    if (!pdf || !selection || !annotationsReady || saving) return
    setSaving(true)
    setAnnotationError('')
    try {
      // Refuse to overwrite changes made by the agent or another open window.
      let current: string | null = null
      try {
        current = await window.humanstudy.project.readText(`${pdf.path}.annotations.json`)
      } catch (e) {
        if (!/ENOENT|no such file/i.test(String(e))) throw e
      }
      if (current !== annotationRaw.current) throw new Error(t('paper.notes_changed'))
      const next = remove
        ? annotations.filter((a) => a.id !== selection.annotationId)
        : [
            ...annotations,
            {
              id: crypto.randomUUID(),
              text: selection.text,
              pages: selection.pages,
              createdAt: new Date().toISOString(),
            },
          ]
      const raw = JSON.stringify({ version: 1, annotations: next }, null, 2) + '\n'
      readPdfAnnotations(raw)
      await window.humanstudy.project.writeText(`${pdf.path}.annotations.json`, raw)
      annotationRaw.current = raw
      setAnnotations(next)
      setSelection(null)
      onSelect?.(null)
      window.getSelection()?.removeAllRanges()
      track(remove ? 'source.annotation_removed' : 'source.annotated', {
        metadata: { pages: selection.pages.map((p) => p.page), chars: selection.text.length },
      })
    } catch (e) {
      setAnnotationError(String(e))
    } finally {
      setSaving(false)
    }
  }

  useEffect(() => {
    setDoc(null)
    setPages([])
    setErr(null)
    if (!open || !pdf) return
    let live = true
    // Older papers often leave standard fonts unembedded; pdfjs needs its font data to draw their text.
    const base = new URL('pdfjs/', document.baseURI).href
    const task = pdfjs.getDocument({
      url: pdf.url,
      standardFontDataUrl: `${base}standard_fonts/`,
      cMapUrl: `${base}cmaps/`,
      cMapPacked: true,
      useSystemFonts: false,
      isEvalSupported: false,
    })
    task.promise.then(
      (d) => {
        if (live) setDoc(d)
      },
      (e: unknown) => {
        if (live) setErr(String(e))
      },
    )
    return () => {
      live = false
      void task.destroy()
    }
  }, [open, pdf?.url])

  // Only visible pages and explicitly requested citations extract text.
  const loadPage = useMemo(
    () =>
      doc
        ? createPageCache(async (n: number): Promise<PageInfo> => {
            const page = await doc.getPage(n),
              vp = page.getViewport({ scale: 1 })
            const content = await page.getTextContent()
            const measure = document.createElement('canvas').getContext('2d')!
            const items = content.items.filter((i): i is Extract<typeof i, { str: string }> => 'str' in i)
            return {
              n,
              w: vp.width,
              h: vp.height,
              words: makeWords(items, content.styles, vp, measure, pdfjs.Util.transform),
            }
          })
        : null,
    [doc],
  )
  useEffect(() => {
    if (!doc) return
    let live = true
    void doc
      .getPage(1)
      .then((page) => {
        const vp = page.getViewport({ scale: 1 })
        if (live)
          setPages(Array.from({ length: doc.numPages }, (_, i) => ({ n: i + 1, w: vp.width, h: vp.height, words: [] })))
      })
      .catch((e) => {
        if (live) setErr(String(e))
      })
    return () => {
      live = false
    }
  }, [doc])

  // The page in view: the one the app scrolled to, then whatever the reader scrolls to.
  const shown = useRef(0)
  const noteShown = (page: number, by: 'citation' | 'scroll') => {
    if (shown.current === page) return
    track('source.page', {
      target: `page.${page}`,
      durationMs: shown.current ? lap('source.page') : (lap('source.page'), undefined),
      metadata: { page, from: shown.current || null, by },
    })
    shown.current = page
    callbacks.current.onPageChange?.(page)
  }
  useEffect(() => {
    const el = host.current
    if (!pages.length || !el || typeof IntersectionObserver === 'undefined') return
    const visible = new Map<Element, number>()
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.set(e.target, e.intersectionRatio)
          else visible.delete(e.target)
        }
        const foremost = [...visible].sort((a, b) => b[1] - a[1])[0]
        if (foremost) noteShown(Number((foremost[0] as HTMLElement).dataset.page), 'scroll')
      },
      { root: el, threshold: [0, 0.25, 0.5, 0.75, 1] },
    )
    el.querySelectorAll('[data-page]').forEach((p) => io.observe(p))
    return () => io.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages.length])

  // A citation: find the quote (cited page first), box it, scroll to it, report what was found.
  useEffect(() => {
    setHit(null)
    setVerdict(null)
    if (!source || !doc || !loadPage || !pages.length || !active) return
    let cancelled = false
    const page = Math.min(doc.numPages, Math.max(1, source.page))
    scrollTo(page)
    const quote = source.quote?.trim() ?? ''
    if (!quote) return
    void (async () => {
      const order = Array.from({ length: doc.numPages }, (_, i) => i + 1).sort(
        (a, b) => Math.abs(a - page) - Math.abs(b - page),
      )
      let found: ReturnType<typeof findQuote> = null
      for (const n of order) {
        if (cancelled) return
        const info = await loadPage(n)
        if (cancelled) return
        found = findQuote([{ page: n, words: info.words }], quote, page)
        if (found) break
      }
      if (cancelled) return
      setHit(found)
      const result: QuoteResult = found
        ? { found: true, page: found.page, ...(found.differs ? { differs: found.differs } : {}) }
        : { found: false }
      setVerdict(result)
      scrollTo(found?.page ?? page, found?.rects[0])
      noteShown(found?.page ?? page, 'citation')
      callbacks.current.onQuote?.(source, result)
      if (!result.found || result.page !== source.page || result.differs)
        track('source.quote_check', {
          target: source.nodeId,
          metadata: { page: source.page, found: result.found, foundOn: result.page ?? null, differs: Boolean(result.differs) },
        })
    })().catch((e) => {
      if (!cancelled) setErr(String(e))
    })
    return () => {
      cancelled = true
    }
  }, [source, doc, loadPage, pages.length, active])
  function scrollTo(page: number, rect?: Rect) {
    const el = host.current,
      target = el?.querySelector<HTMLElement>(`[data-page="${page}"]`)
    if (!el || !target) return
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const top =
          target.getBoundingClientRect().top -
          el.getBoundingClientRect().top +
          el.scrollTop +
          (rect ? (rect.y / 100) * target.offsetHeight - el.clientHeight * 0.3 : -12)
        el.scrollTo({ top: Math.max(0, top), behavior: 'instant' })
      }),
    )
  }

  function capture() {
    setSelecting(false)
    const el = host.current,
      sel = window.getSelection()
    if (
      !el ||
      !sel ||
      sel.isCollapsed ||
      !sel.rangeCount ||
      !el.contains(sel.anchorNode) ||
      !el.contains(sel.focusNode)
    ) {
      if (selection) {
        setSelection(null)
        onSelect?.(null)
      }
      return
    }
    const text = sel.toString().trim()
    const anchor = sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement
    const page = Number(anchor?.closest<HTMLElement>('[data-page]')?.dataset.page)
    if (!text || !page) return
    const box = sel.getRangeAt(0).getBoundingClientRect(),
      base = el.getBoundingClientRect()
    const range = sel.getRangeAt(0)
    const selectedPages: PdfAnnotation['pages'] = []
    for (const pageEl of el.querySelectorAll<HTMLElement>('.pdf-page')) {
      const bounds = pageEl.getBoundingClientRect()
      const rects: Rect[] = []
      const boxes = [...pageEl.querySelectorAll('.pdf-text span')].flatMap((span) => {
        if (!range.intersectsNode(span)) return []
        const part = document.createRange()
        part.selectNodeContents(span)
        if (span.contains(range.startContainer)) part.setStart(range.startContainer, range.startOffset)
        if (span.contains(range.endContainer)) part.setEnd(range.endContainer, range.endOffset)
        return part.toString().length ? [...part.getClientRects()] : []
      })
      for (const r of boxes) {
        const x = Math.max(bounds.left, r.left),
          y = Math.max(bounds.top, r.top)
        const right = Math.min(bounds.right, r.right),
          bottom = Math.min(bounds.bottom, r.bottom)
        if (right > x && bottom > y)
          rects.push({
            x: ((x - bounds.left) / bounds.width) * 100,
            y: ((y - bounds.top) / bounds.height) * 100,
            w: ((right - x) / bounds.width) * 100,
            h: ((bottom - y) / bounds.height) * 100,
          })
      }
      if (rects.length) selectedPages.push({ page: Number(pageEl.dataset.page), rects })
    }
    if (!selectedPages.length) return
    const next = {
      page,
      text,
      pages: selectedPages,
      top: box.top - base.top + el.scrollTop,
      left: Math.min(Math.max(8, box.left - base.left), Math.max(8, el.clientWidth - 260)),
    }
    setSelection(next)
    onSelect?.({ page, text })
    track('source.select', { target: `page.${page}`, metadata: { page, chars: text.length } })
  }

  useEffect(() => {
    if (!selecting) return
    const finish = () => requestAnimationFrame(capture)
    window.addEventListener('mouseup', finish, { once: true })
    return () => window.removeEventListener('mouseup', finish)
  }, [selecting])

  const cited = source?.nodeId ? source : null
  return (
    <div className="source-body">
      {pdf && (
        <div className="paper-tools" aria-label={t('paper.zoom')}>
          <button
            className="ghost"
            aria-label={t('paper.zoom_out')}
            disabled={zoom <= 0.5}
            onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}
          >
            −
          </button>
          <button className="ghost" title={t('paper.fit')} onClick={() => setZoom(1)}>
            {Math.round(zoom * 100)}%
          </button>
          <button
            className="ghost"
            aria-label={t('paper.zoom_in')}
            disabled={zoom >= 3}
            onClick={() => setZoom((z) => Math.min(3, z + 0.25))}
          >
            +
          </button>
        </div>
      )}
      {annotationError && (
        <p role="alert" className="part error pad">
          {annotationError}
        </p>
      )}
      {cited && (
        <div
          className={`paper-cite ${verdict && (!verdict.found || verdict.page !== cited.page || verdict.differs) ? 'warn' : ''}`}
          role="status"
        >
          <span className="paper-cite-page">{t('doc.cite_page', { n: cited.page })}</span>
          {verdict && !verdict.found && <span>{t('model.quote_missing', { n: cited.page })}</span>}
          {verdict?.found && verdict.page !== cited.page && (
            <span>{t('model.quote_moved', { n: cited.page, m: verdict.page ?? '' })}</span>
          )}
          {verdict?.differs && <TokenMismatch differs={verdict.differs} />}
          {verdict?.found && !verdict.differs && <span className="paper-located">{t('paper.located')}</span>}
          {cited.quote && (!verdict || !verdict.found) && <q>{cited.quote}</q>}
          {!cited.quote && <span className="muted">{t('paper.page_only', { page: cited.page })}</span>}
          <button className="link" onClick={onClose}>
            {closeLabel ?? t('paper.back')}
          </button>
        </div>
      )}
      {!pdf && (
        <p className="muted pad">
          {source?.file || source?.sourceId
            ? t('paper.source_unavailable', { file: source.file ?? source.sourceId ?? '' })
            : t('paper.none')}
        </p>
      )}
      {err && <p className="part error pad">{err}</p>}
      <div
        className="pages"
        ref={host}
        onMouseDown={(e) => {
          if (!(e.target as Element).closest('button')) setSelecting(true)
        }}
        onKeyUp={(e) => {
          if (!(e.target as Element).closest('button')) capture()
        }}
      >
        {doc &&
          pages.map((p) => (
            <PdfPage
              key={p.n}
              doc={doc}
              info={p}
              loadPage={loadPage!}
              active={active}
              preserveText={
                selecting ||
                Boolean(selection) ||
                Boolean(window.getSelection()?.rangeCount && !window.getSelection()?.isCollapsed)
              }
              root={host}
              zoom={zoom}
              rects={hit?.page === p.n ? hit.rects : []}
              annotations={annotations.filter((a) => a.pages.some((pn) => pn.page === p.n))}
              onAnnotation={(a) => {
                window.getSelection()?.removeAllRanges()
                setSelection({
                  page: a.pages[0].page,
                  text: a.text,
                  pages: a.pages,
                  annotationId: a.id,
                  top: host.current?.scrollTop ?? 0,
                  left: 8,
                })
                onSelect?.({ page: a.pages[0].page, text: a.text })
              }}
            />
          ))}
        {selection && (
          <div
            className="paper-ask"
            style={{ top: Math.max(host.current?.scrollTop ?? 0, selection.top - 40), left: selection.left }}
            onMouseDown={(e) => e.preventDefault()}
          >
            {supportCount != null && (
              <span>{supportCount ? t('paper.cited_by', { n: supportCount }) : t('paper.cited_none')}</span>
            )}
            <button
              disabled={!annotationsReady || saving}
              onClick={() => void saveAnnotation(Boolean(selection.annotationId))}
            >
              {selection.annotationId ? t('paper.unmark') : t('paper.highlight')}
            </button>
            {onAskPassage && (
              <button
                onClick={() => {
                  onAskPassage({ page: selection.page, text: selection.text })
                  window.getSelection()?.removeAllRanges()
                  setSelection(null)
                  onSelect?.(null)
                }}
              >
                {t('paper.ask')}
              </button>
            )}
            <button
              aria-label={t('paper.dismiss')}
              onClick={() => {
                setSelection(null)
                onSelect?.(null)
                window.getSelection()?.removeAllRanges()
              }}
            >
              ×
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

/** The numbers and signs of a located quote that do not match the source exactly. */
function TokenMismatch({ differs }: { differs: TokenDiff }) {
  const show = (parts: TokenPart[]) =>
    parts.map((p, i) => (
      <span key={i}>
        {i > 0 && ' '}
        {p.changed ? <mark>{p.t}</mark> : p.t}
      </span>
    ))
  return (
    <span className="paper-differs">
      <span>{t('paper.differs')}</span>
      <span>
        {t('paper.differs_quote')} <code>{show(differs.quote)}</code>
      </span>
      <span>
        {t('paper.differs_source')} <code>{show(differs.source)}</code>
      </span>
    </span>
  )
}

/** One page: the canvas (drawn once it is near the viewport), its words and the citation box. */
const PdfPage = memo(
  function PdfPage({
    doc,
    info: initialInfo,
    loadPage,
    active,
    preserveText,
    root,
    rects,
    zoom,
    annotations,
    onAnnotation,
  }: {
    loadPage(n: number): Promise<PageInfo>
    active: boolean
    preserveText: boolean
    zoom: number
    annotations: PdfAnnotation[]
    onAnnotation(a: PdfAnnotation): void
    doc: pdfjs.PDFDocumentProxy
    info: PageInfo
    root: React.RefObject<HTMLDivElement | null>
    rects: Rect[]
  }) {
    const [info, setInfo] = useState(initialInfo)
    const el = useRef<HTMLDivElement>(null)
    const canvas = useRef<HTMLCanvasElement>(null)
    const [width, setWidth] = useState(0)
    useEffect(() => {
      if (!el.current) return
      return observeSettledWidth(el.current, setWidth)
    }, [])
    const [near, setNear] = useState(false)
    const [textReady, setTextReady] = useState(false)
    useEffect(() => {
      if (!active) {
        setNear(false)
        if (!preserveText) setTextReady(false)
        return
      }
      if (!el.current || typeof IntersectionObserver === 'undefined') {
        setNear(true)
        setTextReady(true)
        return
      }
      const io = new IntersectionObserver(
        (es) => {
          const visible = es.some((e) => e.isIntersecting)
          setNear(visible)
          // Keep visited text layers mounted so scrolling cannot destroy a multi-page selection.
          if (visible) setTextReady(true)
          else if (!preserveText) setTextReady(false)
        },
        { root: root.current, rootMargin: '300px 0px' },
      )
      io.observe(el.current)
      return () => io.disconnect()
    }, [root, active, preserveText])
    useEffect(() => {
      if (!near || !active) return
      let live = true
      void loadPage(initialInfo.n)
        .then((p) => {
          if (live) setInfo(p)
        })
        .catch(() => {})
      return () => {
        live = false
      }
    }, [near, active, loadPage, initialInfo.n])
    useEffect(() => {
      if (!active || !near || width <= 0 || !canvas.current || !el.current) return
      let task: pdfjs.RenderTask | null = null,
        cancelled = false
      void doc
        .getPage(info.n)
        .then((page) => {
          if (cancelled || !canvas.current || !el.current) return
          const scale = Math.min(3, (width * devicePixelRatio) / info.w)
          const vp = page.getViewport({ scale })
          canvas.current.width = Math.ceil(vp.width)
          canvas.current.height = Math.ceil(vp.height)
          task = page.render({ canvasContext: canvas.current.getContext('2d')!, viewport: vp })
          return task.promise
        })
        .catch(() => undefined)
      return () => {
        cancelled = true
        task?.cancel()
      }
    }, [active, near, doc, info.n, info.w, width])
    useEffect(() => {
      if (!near && canvas.current) {
        canvas.current.width = 0
        canvas.current.height = 0
      }
    }, [near])
    const ratio = info.h / info.w
    return (
      <div
        ref={el}
        className="pdf-page"
        data-page={info.n}
        style={{
          width: `${zoom * 100}%`,
          maxWidth: `${980 * zoom}px`,
          alignSelf: zoom > 1 ? 'flex-start' : 'center',
          aspectRatio: `${info.w} / ${info.h}`,
        }}
      >
        <canvas ref={canvas} aria-label={t('paper.page_aria', { n: info.n })} />
        {textReady && (
          <div className="pdf-text">
            {info.words.map((w, i) => (
              <span
                key={i}
                style={{
                  left: `${w.x}%`,
                  top: `${w.y}%`,
                  width: `${w.w}%`,
                  height: `${w.h}%`,
                  fontSize: `${w.h * ratio * 0.88}cqw`,
                }}
              >
                {w.t}{' '}
              </span>
            ))}
          </div>
        )}
        {annotations.flatMap((a) =>
          a.pages
            .filter((p) => p.page === info.n)
            .flatMap((p) =>
              p.rects.map((r, i) => (
                <button
                  key={`${a.id}-${i}`}
                  className="pdf-mark"
                  aria-label={t('paper.saved_highlight')}
                  title={a.text}
                  onClick={() => onAnnotation(a)}
                  style={{ left: `${r.x}%`, top: `${r.y}%`, width: `${r.w}%`, height: `${r.h}%` }}
                />
              )),
            ),
        )}
        {rects.map((r, i) => (
          <div
            key={`${info.n}-${i}-${r.x}-${r.y}`}
            className="pdf-box"
            style={{ left: `${r.x}%`, top: `${r.y}%`, width: `${r.w}%`, height: `${r.h}%` }}
          />
        ))}
      </div>
    )
  },
  (a, b) =>
    a.doc === b.doc &&
    a.info === b.info &&
    a.loadPage === b.loadPage &&
    a.active === b.active &&
    a.preserveText === b.preserveText &&
    a.zoom === b.zoom &&
    a.rects.length === b.rects.length &&
    a.rects.every((r, i) => r === b.rects[i]) &&
    a.annotations.length === b.annotations.length &&
    a.annotations.every((r, i) => r === b.annotations[i]),
)
