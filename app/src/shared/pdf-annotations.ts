import type { Rect } from './source-anchor'

export type PdfAnnotation = {
  id: string
  text: string
  createdAt: string
  pages: { page: number; rects: Rect[] }[]
}
export type PdfAnnotations = { version: 1; annotations: PdfAnnotation[] }
/** Keep the complete selected passage; reject malformed files rather than silently dropping notes. */
export function readPdfAnnotations(raw: string): PdfAnnotations {
  const value = JSON.parse(raw) as PdfAnnotations
  if (value?.version !== 1 || !Array.isArray(value.annotations)) throw new Error('Unsupported PDF annotations file')
  const ids = new Set<string>()
  for (const a of value.annotations) {
    if (!a || typeof a.id !== 'string' || ids.has(a.id) || typeof a.text !== 'string' || !a.text.trim() || typeof a.createdAt !== 'string' || !Array.isArray(a.pages) || !a.pages.length) throw new Error('Invalid PDF annotation')
    ids.add(a.id)
    for (const p of a.pages) {
      if (!Number.isInteger(p.page) || p.page < 1 || !Array.isArray(p.rects) || !p.rects.length) throw new Error('Invalid annotation page')
      for (const r of p.rects) {
        if (![r.x, r.y, r.w, r.h].every(Number.isFinite) || r.x < 0 || r.y < 0 || r.w <= 0 || r.h <= 0 || r.x + r.w > 100.01 || r.y + r.h > 100.01) throw new Error('Invalid annotation rectangle')
      }
    }
  }
  return value
}
