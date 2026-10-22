// Small read-only previews shared by the Results cards and the file viewer.
import { useEffect, useState } from 'react'
import type { ProjectEntry } from '../../preload/types'
import { parseCsvHead } from '../results'

const cache = new Map<string, string>()

/** The start of a text file (up to `max` characters); cached per file version, null while loading. */
export function useFileText(entry: ProjectEntry, enabled = true, max = 20000): string | null {
  const key = `${entry.path}|${entry.version ?? `${entry.mtime ?? 0}|${entry.size ?? 0}`}`
  const [text, setText] = useState<string | null>(() => cache.get(key) ?? null)
  useEffect(() => {
    if (!enabled) return
    const hit = cache.get(key)
    if (hit !== undefined) return setText(hit)
    let live = true
    window.humanstudy.project
      .readText(entry.path)
      .then((t) => {
        const head = t.slice(0, max)
        cache.set(key, head)
        if (live) setText(head)
      })
      .catch(() => live && setText(''))
    return () => {
      live = false
    }
  }, [key, enabled, entry.path, max])
  return text
}

export function CsvTable({ text, rows = 6, cols = 6 }: { text: string; rows?: number; cols?: number }) {
  const { rows: data } = parseCsvHead(text, rows, cols)
  if (!data.length) return null
  const [head, ...body] = data
  return (
    <table className="csv-table">
      <thead>
        <tr>
          {head.map((c, i) => (
            <th key={i}>{c}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {body.map((r, i) => (
          <tr key={i}>
            {r.map((c, j) => (
              <td key={j}>{c}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

import type { FileVersion } from '../../preload/types'

/** Saved versions of a file (oldest first); reloads when the file changes. */
export function useVersions(entry: ProjectEntry | null): FileVersion[] {
  const [list, setList] = useState<FileVersion[]>([])
  const key = entry ? `${entry.path}|${entry.version ?? `${entry.mtime ?? 0}|${entry.size ?? 0}`}` : ''
  useEffect(() => {
    if (!entry) return setList([])
    let live = true
    // The main process snapshots a moment after the write; look again shortly.
    const load = () => window.humanstudy.project.versions(entry.path).then((v) => live && setList(v)).catch(() => undefined)
    void load()
    const again = window.setTimeout(load, 900)
    return () => {
      live = false
      window.clearTimeout(again)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return list
}
