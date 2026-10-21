// Ported from humanstudy-hub-web lib/studio/pdf-client.ts (makeWords): pdf.js text runs split into
// positioned words, in percent of the page, so a transparent text layer can sit over the canvas and
// a cited quote can be boxed (shared/source-anchor.ts). Browser-only: it measures with a canvas.
import type { Word } from '../../shared/source-anchor'

const clampPercent = (v: number) => Math.max(0, Math.min(100, v))

export function makeWords(
  items: Array<{ str: string; width: number; transform: number[]; dir?: string; fontName?: string }>,
  styles: Record<string, { fontFamily?: string }>,
  viewport: { width: number; height: number; scale: number; transform: number[] },
  measure: CanvasRenderingContext2D,
  transform: (a: number[], b: number[]) => number[],
): Word[] {
  const words: Word[] = []
  for (const item of items) {
    if (!item.str.trim() || !item.transform || item.transform.length < 6) continue
    const tx = transform(viewport.transform, item.transform)
    const fontHeight = Math.hypot(tx[2], tx[3])
    const axisLength = Math.hypot(tx[0], tx[1])
    const itemWidth = item.width * viewport.scale
    if (!fontHeight || !axisLength || !itemWidth) continue
    measure.font = `${fontHeight}px ${styles[item.fontName ?? '']?.fontFamily || 'sans-serif'}`
    const chunks = [...item.str.matchAll(/\s+|\S+/gu)].map((m) => ({
      text: m[0],
      width: measure.measureText(m[0]).width,
    }))
    const measuredWidth = chunks.reduce((sum, c) => sum + c.width, 0) || 1
    let advance = 0
    const ux = tx[0] / axisLength,
      uy = tx[1] / axisLength
    const vx = tx[2] / fontHeight,
      vy = tx[3] / fontHeight
    const rtl = item.dir === 'rtl'
    for (const chunk of chunks) {
      const token = chunk.text,
        offset = advance / measuredWidth
      advance += chunk.width
      if (!token.trim()) continue
      const width = (chunk.width / measuredWidth) * itemWidth
      const along = (rtl ? 1 - offset - width / itemWidth : offset) * itemWidth
      const bx = tx[4] + ux * along,
        by = tx[5] + uy * along
      // A conservative font box around the baseline; also handles rotated text.
      const corners = [
        [bx - vx * fontHeight * 0.2, by - vy * fontHeight * 0.2],
        [bx + ux * width - vx * fontHeight * 0.2, by + uy * width - vy * fontHeight * 0.2],
        [bx + vx * fontHeight * 0.8, by + vy * fontHeight * 0.8],
        [bx + ux * width + vx * fontHeight * 0.8, by + uy * width + vy * fontHeight * 0.8],
      ]
      const left = Math.max(0, Math.min(...corners.map(([x]) => x)))
      const top = Math.max(0, Math.min(...corners.map(([, y]) => y)))
      const right = Math.min(viewport.width, Math.max(...corners.map(([x]) => x)))
      const bottom = Math.min(viewport.height, Math.max(...corners.map(([, y]) => y)))
      if (right > left && bottom > top)
        words.push({
          t: token,
          x: clampPercent((left / viewport.width) * 100),
          y: clampPercent((top / viewport.height) * 100),
          w: clampPercent(((right - left) / viewport.width) * 100),
          h: clampPercent(((bottom - top) / viewport.height) * 100),
        })
    }
  }
  return words
}
