// Pure helpers for artifact cards: what kind a file the agent wrote is, and its human title. No React, no window: runs in the renderer and in node tests.

export type ResultKind = 'chart' | 'figure' | 'report' | 'table' | 'data' | 'simulation' | 'draft' | 'document' | 'file'

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'])

const fwd = (p: string) => p.replace(/\\/g, '/')
const baseName = (p: string) => fwd(p).split('/').pop() ?? p
export const extOf = (p: string) => {
  const b = baseName(p)
  const i = b.lastIndexOf('.')
  return i > 0 ? b.slice(i + 1).toLowerCase() : ''
}

export function resultKind(rel: string): ResultKind {
  const r = fwd(rel)
  const name = baseName(r).toLowerCase()
  const ext = extOf(r)
  if (/simulat|replay|evaluation|sessions/.test(r.toLowerCase()) || r.startsWith('package/')) return 'simulation'
  if (/prereg|pre-reg|registration|draft|proposal|manuscript/.test(name)) return 'draft'
  if (IMAGE.has(ext)) return 'figure'
  if (ext === 'html' || ext === 'htm') return 'chart'
  if (ext === 'md' || ext === 'markdown' || ext === 'txt') return 'report'
  if (ext === 'csv' || ext === 'tsv') return 'table'
  if (ext === 'json') return 'data'
  if (ext === 'pdf' || ext === 'docx' || ext === 'doc') return 'document'
  return 'file'
}

/** "2026-10-11-participant_flow.html" -> "Participant flow". */
export function deSlug(fileName: string): string {
  let s = baseName(fileName).replace(/\.[A-Za-z0-9]{1,5}$/, '')
  s = s.replace(/^\d{4}-\d{2}-\d{2}[-_ T]*/, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!s) s = baseName(fileName)
  return s.charAt(0).toUpperCase() + s.slice(1)
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' }
const decode = (s: string) => s.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m)
const stripTags = (s: string) => s.replace(/<[^>]*>/g, '')
const clean = (s: string) => decode(stripTags(s)).replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim()

/** Human title: <title> or first <h1> of HTML, first heading of Markdown, a "title" key of JSON,
 *  otherwise the file name without extension, de-slugged. `text` is the start of the file when known. */
export function resultTitle(rel: string, text?: string): string {
  const ext = extOf(rel)
  const fallback = deSlug(rel)
  if (!text) return fallback
  let found = ''
  if (ext === 'html' || ext === 'htm') {
    const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text)?.[1] ?? /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(text)?.[1]
    if (t) found = clean(t)
  } else if (ext === 'md' || ext === 'markdown') {
    const h = /^\s{0,3}#{1,3}\s+(.+?)\s*#*\s*$/m.exec(text)?.[1]
    if (h) found = clean(h)
  } else if (ext === 'json') {
    try {
      const v = JSON.parse(text) as { title?: unknown }
      if (v && typeof v === 'object' && typeof v.title === 'string') found = clean(v.title)
    } catch {
      /* a truncated head is fine: fall back to the name */
    }
  }
  return (found || fallback).slice(0, 90)
}

/** First rows of a CSV/TSV for a card; quoted fields and doubled quotes are handled. */
export function parseCsvHead(text: string, maxRows = 6, maxCols = 6): { rows: string[][]; cols: number } {
  const delim = /^[^\n"]*\t/.test(text) && !/^[^\n"]*,/.test(text) ? '\t' : ','
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  let cols = 0
  const endRow = () => {
    row.push(cell)
    cell = ''
    cols = Math.max(cols, row.length)
    rows.push(row)
    row = []
  }
  for (let i = 0; i < text.length && rows.length < maxRows; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (cell += '"'), i++
      else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === delim) (row.push(cell), (cell = ''))
    else if (c === '\n') endRow()
    else if (c !== '\r') cell += c
  }
  if (rows.length < maxRows && (cell || row.length)) endRow()
  return { rows: rows.map((r) => r.slice(0, maxCols)), cols }
}

/** Pretty-print JSON for a card; returns the input when it does not parse (e.g. a truncated head). */
export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}
