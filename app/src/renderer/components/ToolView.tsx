// A tool call in the chat. Edits and writes show the file; a unified diff in the detail is coloured.
import type { Part } from '../useSession'
import { DiffBlock, isDiff } from './Permission'
import { displayPath } from '../../shared/display-path'

const firstLine = (s: string) => s.split('\n')[0].slice(0, 120)
const basename = (p: string) => p.replace(/\\/g, '/').split('/').pop() ?? p

/** The file a diff touches: `+++ b/path`, else `--- a/path`, else the first line. */
export function diffFile(detail: string): string {
  const lines = detail.split('\n')
  const hit = lines.find((l) => l.startsWith('+++ ') && !l.includes('/dev/null')) ?? lines.find((l) => l.startsWith('--- ') && !l.includes('/dev/null'))
  if (hit) return hit.slice(4).replace(/^[ab]\//, '').split('\t')[0].trim()
  return firstLine(detail)
}

// Tools whose one-line detail is a file or folder path.
const PATH_TOOLS = new Set(['read', 'list', 'glob', 'edit', 'write', 'patch', 'multiedit'])

export function ToolView({ part, onOpenStudy, projectDir, home }: { part: Extract<Part, { kind: 'tool' }>; onOpenStudy?(): void; projectDir?: string; home?: string }) {
  const detail = part.detail
  const diff = isDiff(detail)
  const fileTool = part.tool === 'edit' || part.tool === 'write' || part.tool === 'patch' || part.tool === 'multiedit'
  const rawFile = fileTool && detail ? (diff ? diffFile(detail) : firstLine(detail)) : null
  const file = rawFile ? displayPath(rawFile, projectDir, home) : null
  const shownDetail = detail && PATH_TOOLS.has(part.tool) && !fileTool ? displayPath(firstLine(detail), projectDir, home) : detail && firstLine(detail)
  const counts = diff && detail ? countLines(detail) : null
  const isProgram = file ? basename(rawFile ?? file) === 'program.json' : false
  return (
    <details className={`part tool${diff ? ' has-diff' : ''}`} open={diff || undefined}>
      <summary>
        <span className="tool-dot" />
        <span className="tool-name">{part.tool}</span>
        {file ? <span className="tool-file" title={file}>{file}</span> : shownDetail && <span className="tool-detail">{shownDetail}</span>}
        {counts && (
          <span className="diff-count">
            <span className="add">+{counts.add}</span> <span className="del">−{counts.del}</span>
          </span>
        )}
        {isProgram && onOpenStudy && (
          <button
            className="link tool-link"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onOpenStudy()
            }}
          >
            Show in Study
          </button>
        )}
      </summary>
      {detail && (diff ? <DiffBlock text={detail} /> : <pre>{detail}</pre>)}
    </details>
  )
}

function countLines(text: string) {
  let add = 0
  let del = 0
  for (const l of text.split('\n')) {
    if (l.startsWith('+') && !l.startsWith('+++')) add++
    else if (l.startsWith('-') && !l.startsWith('---')) del++
  }
  return { add, del }
}
