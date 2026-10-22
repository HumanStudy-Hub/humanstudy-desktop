// A researcher's edit of one study field, applied to program.json as it is on disk. Only the bytes of
// that field's value, origin and state change: duplicates, misplaced steps, odd formatting and
// everything else the tolerant reader sets aside stay exactly as they were. The app never writes its
// normalised view of the program back to disk.
import { readHumanProgram } from './human-program'

type Span = { start: number; end: number }
type Node =
  | (Span & { kind: 'object'; members: { key: string; value: Node }[] })
  | (Span & { kind: 'array'; items: Node[] })
  | (Span & { kind: 'value'; value: unknown })

/** Parses JSON text keeping each value's [start, end) offsets. Throws on invalid JSON. */
export function parseWithSpans(text: string): Node {
  let i = 0
  const ws = () => { while (i < text.length && ' \t\n\r﻿'.includes(text[i]!)) i++ }
  const fail = (what: string): never => { throw new Error(`program.json: ${what} at offset ${i}`) }
  const str = (): string => {
    const start = i
    if (text[i] !== '"') fail('expected a string')
    i++
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1
    if (i >= text.length) fail('unterminated string')
    i++
    return JSON.parse(text.slice(start, i)) as string
  }
  const value = (depth: number): Node => {
    if (depth > 128) fail('too deeply nested')
    ws()
    const start = i
    const c = text[i]
    if (c === '{') {
      i++
      const members: { key: string; value: Node }[] = []
      ws()
      if (text[i] === '}') { i++; return { kind: 'object', members, start, end: i } }
      for (;;) {
        ws()
        const key = str()
        ws()
        if (text[i] !== ':') fail('expected ":"')
        i++
        members.push({ key, value: value(depth + 1) })
        ws()
        if (text[i] === ',') { i++; continue }
        if (text[i] === '}') { i++; return { kind: 'object', members, start, end: i } }
        fail('expected "," or "}"')
      }
    }
    if (c === '[') {
      i++
      const items: Node[] = []
      ws()
      if (text[i] === ']') { i++; return { kind: 'array', items, start, end: i } }
      for (;;) {
        items.push(value(depth + 1))
        ws()
        if (text[i] === ',') { i++; continue }
        if (text[i] === ']') { i++; return { kind: 'array', items, start, end: i } }
        fail('expected "," or "]"')
      }
    }
    if (c === '"') return { kind: 'value', value: str(), start, end: i }
    const m = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i, i + 64))
    if (!m) fail('unexpected character')
    i += m![0].length
    return { kind: 'value', value: JSON.parse(m![0]), start, end: i }
  }
  const root = value(0)
  ws()
  if (i !== text.length) fail('unexpected trailing text')
  return root
}

// JSON.parse keeps the last of repeated keys; so does this lookup.
const member = (n: Node | undefined, key: string): Node | undefined =>
  n?.kind === 'object' ? n.members.filter((m) => m.key === key).at(-1)?.value : undefined
const idOf = (n: Node) => { const v = member(n, 'id'); return v?.kind === 'value' ? v.value : undefined }
// The tolerant reader keeps the first entry of a duplicated id, so the edit lands on that one.
const byId = (list: Node | undefined, id: string) => (list?.kind === 'array' ? list.items.find((x) => idOf(x) === id) : undefined)

/** The field a study-view id names: `flow:<stepId>` is that step's rule, anything else a node field. */
function locate(root: Node, id: string, fieldId: string): Node | undefined {
  if (id.startsWith('flow:')) return member(byId(member(root, 'steps'), id.slice(5)), 'rule')
  return byId(member(byId(member(root, 'nodes'), id), 'fields'), fieldId)
}

export interface FieldEdit { id: string; fieldId: string; value: string }

/** program.json text with one field set to the researcher's value (origin researcher, state
 *  confirmed). Every other byte is kept. Throws when the field is not in the file, or when the result
 *  would no longer load. */
export function patchProgramField(raw: string, edit: FieldEdit): string {
  const root = parseWithSpans(raw)
  const field = locate(root, edit.id, edit.fieldId)
  if (!field || field.kind !== 'object') throw new Error(`field ${edit.fieldId} of ${edit.id} is not in program.json`)
  const wanted: Record<string, string> = { value: edit.value, origin: 'researcher', state: 'confirmed' }
  const changes: { span: Span; text: string }[] = []
  const absent: string[] = []
  for (const [key, v] of Object.entries(wanted)) {
    const at = member(field, key)
    if (!at) absent.push(key)
    else if (at.kind !== 'value' || at.value !== v) changes.push({ span: at, text: JSON.stringify(v) })
  }
  if (absent.length) {
    // A required key is missing (the reader would have refused the file); add it after the last member.
    const last = field.members.at(-1)?.value
    const add = absent.map((k) => `${JSON.stringify(k)}: ${JSON.stringify(wanted[k])}`).join(', ')
    changes.push(last ? { span: { start: last.end, end: last.end }, text: `, ${add}` } : { span: { start: field.start + 1, end: field.end - 1 }, text: add })
  }
  let out = raw
  for (const c of changes.sort((a, b) => b.span.start - a.span.start)) out = out.slice(0, c.span.start) + c.text + out.slice(c.span.end)
  readHumanProgram(JSON.parse(out)) // still a Human Program the app can open
  return out
}
