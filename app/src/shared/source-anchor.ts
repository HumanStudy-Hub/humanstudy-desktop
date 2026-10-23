// Ported from humanstudy-hub-web lib/studio/source-anchor.ts. The web version matches the quote
// against the page's words after whitespace normalisation; this one also ignores punctuation and
// line-break hyphens ("confi- dence"), which older scanned papers are full of. Explicit ellipses
// require every remaining passage to match. No match, or an ambiguous one, returns [].

import { compareSignificant, mergeDiffs, normalizeSignificant, significantTokens, type TokenDiff } from './significant-tokens'

export type Rect = { x: number; y: number; w: number; h: number }
/** One word of a PDF page in percent of the page box (see renderer/components/pdf-words.ts). */
export type Word = { t: string; x: number; y: number; w: number; h: number }

const fold = (text: string) =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')

/** Where a quote sits among a page's words: the words to box, and the source text of each matched
 * passage (for the exact comparison of numbers and signs in significant-tokens.ts). */
export type QuoteMatch = { words: Word[]; parts: { quote: string; source: string }[] }

/** Locate a quoted passage in a page's words. Never invent a box. */
export function quoteRects(words: Word[], quote: string): Rect[] {
  const found = locateQuote(words, quote)
  return found ? merge(found.words) : []
}

export function locateQuote(words: Word[], quote: string): QuoteMatch | null {
  if (!words.length) return null
  // `raw` is the page text as extracted (normalised, words joined by spaces); every folded character
  // remembers where it came from, so a match can be read back with its punctuation and signs.
  const owner: number[] = [],
    from: number[] = [],
    to: number[] = []
  let hay = '',
    raw = ''
  words.forEach((word, i) => {
    if (i) raw += ' '
    for (const ch of normalizeSignificant(word.t)) {
      const at = raw.length
      raw += ch
      const part = fold(ch)
      hay += part
      for (let k = 0; k < part.length; k++) owner.push(i), from.push(at), to.push(raw.length)
    }
  })
  const unique = (needle: string): number => {
    const at = hay.indexOf(needle)
    // An ambiguous repeated passage needs the reader, not an arbitrary highlight.
    return at < 0 || hay.indexOf(needle, at + 1) >= 0 ? -1 : at
  }
  const span = (start: number, length: number) => words.slice(owner[start], owner[start + length - 1] + 1)
  const sourceOf = (start: number, length: number, piece: string) => sourceText(raw, from[start], to[start + length - 1], piece)
  // Require the whole quote or every ordered part of an explicitly abbreviated quote.
  const rawPieces = quote.split(/\[\s*\.\.\.\s*\]|\.\.\.|…/).filter((p) => fold(p))
  const whole = fold(quote)
  if (whole.length < 6) return null
  const at = unique(whole)
  if (at >= 0) return { words: span(at, whole.length), parts: [{ quote, source: sourceOf(at, whole.length, quote) }] }
  if (rawPieces.length > 1) {
    const parts: Word[] = [],
      texts: QuoteMatch['parts'] = []
    let last = -1
    for (const piece of rawPieces) {
      const needle = fold(piece),
        at = unique(needle)
      if (at < 0 || at <= last) return null
      parts.push(...span(at, needle.length))
      texts.push({ quote: piece, source: sourceOf(at, needle.length, piece) })
      last = at + needle.length - 1
    }
    return { words: parts, parts: texts }
  }
  return null
}

/** The source text of a match, widened just enough to compare it with the quote: a number cut by the
 * match is completed ("p = .04" against ".045"), and the quote's own leading or trailing signs
 * ("−0.5", "p <") are read from the source too, so a sign outside the letters still counts. */
function sourceText(raw: string, start: number, end: number, quote: string): string {
  const digit = (c?: string) => c !== undefined && c >= '0' && c <= '9'
  const alnum = (c?: string) => c !== undefined && /[\p{L}\p{N}]/u.test(c)
  if (digit(raw[start])) {
    while (start > 0 && (digit(raw[start - 1]) || (/[.,]/.test(raw[start - 1]) && digit(raw[start - 2])))) start--
    if (raw[start - 1] === '.') start--
    if (/[-\u2212]/.test(raw[start - 1] ?? '') && !alnum(raw[start - 2])) start--
    // A minus set as its own glyph ("− 2.10"), but not a range dash between numbers ("18 - 25").
    else if (/\s/.test(raw[start - 1] ?? '') && /[-\u2212]/.test(raw[start - 2] ?? '') && !alnum(raw[start - 3]) && !alnum((raw.slice(0, start - 2).trimEnd()).at(-1)))
      start -= 2
  }
  if (digit(raw[end - 1])) {
    while (end < raw.length && (digit(raw[end]) || (/[.,]/.test(raw[end]) && digit(raw[end + 1])))) end++
    if (raw[end] === '%') end++
  }
  const q = normalizeSignificant(quote)
  const signs = (part: string) => part.replace(/\s/g, '').length
  for (let n = signs(q.match(/^[^\p{L}\p{N}]*/u)![0]); n > 0 && start > 0 && !alnum(raw[start - 1]); start--)
    if (!/\s/.test(raw[start - 1])) n--
  for (let n = signs(q.match(/[^\p{L}\p{N}]*$/u)![0]); n > 0 && end < raw.length && !alnum(raw[end]); end++)
    if (!/\s/.test(raw[end])) n--
  return raw.slice(start, end)
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

/** Found on a page; `differs` lists numbers or signs that do not match exactly (located is not checked). */
export type QuoteHit = { page: number; rects: Rect[]; differs?: TokenDiff }
/** The cited page first, then the rest: a quote found elsewhere is a citation with the wrong page. */
export function findQuote(pages: { page: number; words: Word[] }[], quote: string, page: number): QuoteHit | null {
  if (!quote.trim()) return null
  const order = [...pages].sort(
    (a, b) => Number(b.page === page) - Number(a.page === page) || Math.abs(a.page - page) - Math.abs(b.page - page),
  )
  for (const p of order) {
    const found = locateQuote(p.words, quote)
    if (!found) continue
    const differs = mergeDiffs(
      found.parts.map((x) => compareSignificant(x.quote, x.source)),
      found.parts.map((x) => ({ quote: significantTokens(x.quote), source: significantTokens(x.source) })),
    )
    return { page: p.page, rects: merge(found.words), ...(differs ? { differs } : {}) }
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
