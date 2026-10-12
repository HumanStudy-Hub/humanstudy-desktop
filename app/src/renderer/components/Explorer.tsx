// Program explorer: the project folder as a tree, like an editor's file explorer.
import { useState } from 'react'
import type { ProjectEntry } from '../../preload/types'

interface Props {
  tree: ProjectEntry[]
  name: string
  activePath: string | null
  dirty: Set<string>
  onOpen(entry: ProjectEntry): void
}

/** Every file in the tree, in display order. */
export function flatten(tree: ProjectEntry[]): ProjectEntry[] {
  return tree.flatMap((e) => (e.kind === 'dir' ? flatten(e.children ?? []) : [e]))
}

const GLYPH: Record<string, string> = {
  pdf: 'PDF',
  json: '{ }',
  md: 'M↓',
  html: '<>',
  htm: '<>',
  py: 'py',
  png: 'img',
  jpg: 'img',
  jpeg: 'img',
  svg: 'svg',
  csv: 'csv',
  docx: 'doc',
  zip: 'zip',
  txt: 'txt',
}

export function Explorer({ tree, name, activePath, dirty, onOpen }: Props) {
  return (
    <aside className="explorer" aria-label="Program files">
      <div className="explorer-head" title={name}>
        {name}
      </div>
      <div className="explorer-tree">
        {tree.length ? <Branch entries={tree} depth={0} activePath={activePath} dirty={dirty} onOpen={onOpen} /> : <p className="muted small explorer-empty">Empty project.</p>}
      </div>
    </aside>
  )
}

function Branch({ entries, depth, activePath, dirty, onOpen }: { entries: ProjectEntry[]; depth: number } & Omit<Props, 'tree' | 'name'>) {
  return (
    <ul role={depth ? 'group' : 'tree'}>
      {entries.map((e) => (e.kind === 'dir' ? <Folder key={e.path} entry={e} depth={depth} activePath={activePath} dirty={dirty} onOpen={onOpen} /> : <File key={e.path} entry={e} depth={depth} active={activePath === e.path} dirty={dirty.has(e.path)} onOpen={onOpen} />))}
    </ul>
  )
}

function Folder({ entry, depth, ...rest }: { entry: ProjectEntry; depth: number } & Omit<Props, 'tree' | 'name'>) {
  const [open, setOpen] = useState(depth === 0 && entry.name !== 'schema')
  return (
    <li role="treeitem" aria-expanded={open}>
      <button className="tree-row" style={{ paddingLeft: 10 + depth * 14 }} onClick={() => setOpen(!open)}>
        <span className={`tree-caret ${open ? 'open' : ''}`} aria-hidden>
          ▸
        </span>
        <span className="tree-name">{entry.name}</span>
        {!open && entry.children?.length ? <span className="tree-count">{entry.children.length}</span> : null}
      </button>
      {open && entry.children && <Branch entries={entry.children} depth={depth + 1} {...rest} />}
    </li>
  )
}

function File({ entry, depth, active, dirty, onOpen }: { entry: ProjectEntry; depth: number; active: boolean; dirty: boolean; onOpen(e: ProjectEntry): void }) {
  return (
    <li role="treeitem" aria-selected={active}>
      <button className={`tree-row ${active ? 'active' : ''}`} style={{ paddingLeft: 10 + depth * 14 }} onClick={() => onOpen(entry)} onDoubleClick={() => void window.humanstudy.project.reveal(entry.path)} title={`${entry.rel}${entry.size !== undefined ? ` · ${size(entry.size)}` : ''}`}>
        <span className="tree-glyph" data-ext={entry.ext} aria-hidden>
          {GLYPH[entry.ext] ?? (entry.ext ? entry.ext.slice(0, 3) : '·')}
        </span>
        <span className="tree-name">{entry.name}</span>
        {dirty && <span className="tree-dirty" aria-label="unsaved" />}
      </button>
    </li>
  )
}

export function size(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
