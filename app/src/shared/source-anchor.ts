// Ported from humanstudy-hub-web lib/studio/source-anchor.ts. The web version matches the quote
// against the page's words after whitespace normalisation; this one also ignores punctuation and
// line-break hyphens ("confi- dence"), which older scanned papers are full of. Explicit ellipses
// require every remaining passage to match. No match, or an ambiguous one, returns [].

export type Rect = { x: number; y: number; w: number; h: number }
/** One word of a PDF page in percent of the page box (see renderer/components/pdf-words.ts). */
export type Word = { t: string; x: number; y: number; w: number; h: number }

const fold = (text: string) =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')

/** Locate a quoted passage in a page's words. Never invent a box. */
export function quoteRects(words: Word[], quote: string): Rect[] {
  if (!words.length) return []
  const owner: number[] = []
  let hay = ''
  words.forEach((word, i) => {
    const part = fold(word.t)
    hay += part
    for (let k = 0; k < part.length; k++) owner.push(i)
  })
  const unique = (needle: string): number => {
    const at = hay.indexOf(needle)
    // An ambiguous repeated passage needs the reader, not an arbitrary highlight.
    return at < 0 || hay.indexOf(needle, at + 1) >= 0 ? -1 : at
  }
  const span = (start: number, length: number) => words.slice(owner[start], owner[start + length - 1] + 1)
  // Require the whole quote or every ordered part of an explicitly abbreviated quote.
  const pieces = quote
    .split(/\[\s*\.\.\.\s*\]|\.\.\.|…/)
    .map(fold)
    .filter(Boolean)
  const whole = fold(quote)
  if (whole.length < 6) return []
  const find = (needle: string): Word[] => {
    const at = unique(needle)
    return at < 0 ? [] : span(at, needle.length)
  }
  const exact = find(whole)
  if (exact.length) return merge(exact)
  if (pieces.length > 1) {
    const parts: Word[] = []
    let last = -1
    for (const piece of pieces) {
      const at = unique(piece)
      if (at < 0 || at <= last) return []
      parts.push(...span(at, piece.length))
      last = at + piece.length - 1
    }
    return merge(parts)
  }
  return []
}

/** Merge adjacent words on the same line so the box hugs the passage. */
function merge(boxes: Rect[]): Rect[] {
  const result: Rect[] = []
  for (const b of boxes) {
    const box = { x: b.x, y: b.y, w: Math.min(b.w, 100 - b.x), h: Math.min(b.h, 100 - b.y) }
    const prev = result[result.length - 1]
    if (
      prev &&
      Math.abs(prev.y - box.y) < Math.min(prev.h, box.h) * 0.4 &&
      box.x >= prev.x &&
      box.x <= prev.x + prev.w + 2
    ) {
      prev.w = Math.max(prev.x + prev.w, box.x + box.w) - prev.x
      prev.h = Math.max(prev.h, box.y + box.h - prev.y)
    } else result.push(box)
  }
  return result
}

export type QuoteHit = { page: number; rects: Rect[] }
/** The cited page first, then the rest: a quote found elsewhere is a citation with the wrong page. */
export function findQuote(pages: { page: number; words: Word[] }[], quote: string, page: number): QuoteHit | null {
  if (!quote.trim()) return null
  const order = [...pages].sort(
    (a, b) => Number(b.page === page) - Number(a.page === page) || Math.abs(a.page - page) - Math.abs(b.page - page),
  )
  for (const p of order) {
    const rects = quoteRects(p.words, quote)
    if (rects.length) return { page: p.page, rects }
  }
  return null
}

/** Map selection bounds to page coordinates, independent of zoom and scrolling. */
export function sourceRect(
  page: { left: number; top: number; width: number; height: number },
  selection: { left: number; top: number; width: number; height: number },
): Rect | null {
  if (page.width <= 0 || page.height <= 0) return null
  const left = Math.max(page.left, selection.left),
    top = Math.max(page.top, selection.top)
  const right = Math.min(page.left + page.width, selection.left + selection.width),
    bottom = Math.min(page.top + page.height, selection.top + selection.height)
  if (right <= left || bottom <= top) return null
  return {
    x: ((left - page.left) / page.width) * 100,
    y: ((top - page.top) / page.height) * 100,
    w: ((right - left) / page.width) * 100,
    h: ((bottom - top) / page.height) * 100,
  }
}

/** Key of a citation for its verification status. */
export const quoteKey = (page: number | undefined, quote: string | undefined, resource?: string) =>
  JSON.stringify([resource ?? '', page ?? 0, quote ?? ''])
