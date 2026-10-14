// Tool calls in plain language. classifyTool() turns (tool, input/detail) into what the agent is
// doing; toolSentence() turns that into an i18n key plus variables. Pure, so it is tested in node.
import { deSlug } from './results'

export interface ToolLike {
  tool: string
  detail?: string
  input?: unknown
  state?: string
}

export type ToolAction =
  | { type: 'clarify' }
  | { type: 'simulate' }
  | { type: 'read-paper'; page?: number }
  | { type: 'read-study' }
  | { type: 'read-file'; file: string }
  | { type: 'write-study' }
  | { type: 'write-result'; rel: string; create: boolean }
  | { type: 'write-package'; rel: string }
  | { type: 'write-file'; rel: string }
  | { type: 'browse' }
  | { type: 'check-package' }
  | { type: 'run-python'; analysis?: boolean }
  | { type: 'install' }
  | { type: 'make-folder' }
  | { type: 'run-command'; cmd: string }
  | { type: 'open-web'; host: string }
  | { type: 'search-web'; query?: string }
  | { type: 'delegate' }
  | { type: 'plan' }
  | { type: 'use-skill'; name: string }
  | { type: 'other'; tool: string }

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})
const fwd = (p: string) => p.replace(/\\/g, '/')
const base = (p: string) => fwd(p).split('/').pop() ?? p
const firstLine = (s: string) => s.split('\n')[0].trim()

/** Project-relative path with forward slashes; paths outside the project stay absolute. */
function relPath(p: string, projectDir?: string): string {
  const x = fwd(p.trim())
  const root = projectDir ? fwd(projectDir).replace(/\/+$/, '') : ''
  if (root && x.startsWith(root + '/')) return x.slice(root.length + 1)
  return x.replace(/^\.\//, '')
}

/** The file a unified diff touches (`+++ b/path`). */
function diffTarget(detail: string): string | undefined {
  const lines = detail.split('\n')
  const hit = lines.find((l) => l.startsWith('+++ ') && !l.includes('/dev/null')) ?? lines.find((l) => l.startsWith('--- ') && !l.includes('/dev/null'))
  return hit ? hit.slice(4).replace(/^[ab]\//, '').split('\t')[0].trim() : undefined
}

function targetFile(part: ToolLike, projectDir?: string): string {
  const i = obj(part.input)
  const given = str(i.filePath) ?? str(i.file_path) ?? str(i.path) ?? str(i.file)
  if (given) return relPath(given, projectDir)
  const d = part.detail ?? ''
  const fromDiff = d.includes('\n') ? diffTarget(d) : undefined
  return relPath(fromDiff ?? firstLine(d), projectDir)
}

function pageOf(...texts: (string | undefined)[]): number | undefined {
  for (const t of texts) {
    const m = t && /(?:pages?|p\.|\s-f\s)\s*(\d{1,4})/i.exec(t)
    if (m) return Number(m[1])
  }
  return undefined
}

const BROWSE_CMD = /^(ls|find|tree|pwd|rg|grep|fd|wc|du|stat|file|which|echo|test|cd)\b/
const READ_CMD = /^(cat|head|tail|less|sed -n|bat)\b/

function classifyBash(cmd: string): ToolAction {
  const c = cmd.trim()
  if (/\bhs-pdf\b|\bpdftotext\b|\bpdftoppm\b|\bpdfinfo\b/.test(c) || /\bpdfplumber\b|\bPyPDF|\bfitz\b/.test(c) || (/paper\.pdf/.test(c) && !/^(rm|mv|cp)\b/.test(c)))
    return { type: 'read-paper', page: pageOf(c) }
  if (/check_package|validate_package|check-package/.test(c)) return { type: 'check-package' }
  if (/^(pip3?|python3? -m pip|npm|pnpm|brew|uv)\s+(install|add)\b/.test(c)) return { type: 'install' }
  if (/^mkdir\b/.test(c)) return { type: 'make-folder' }
  if (/\b(run_simulation|run_sessions)\b|artifacts\/simulations\//.test(c)) return { type: 'simulate' }
  if (/^(python3?|uv run python|Rscript)\b/.test(c)) return { type: 'run-python', analysis: /(?:analy[sz]e|analysis|evaluat|regression|anova|statsmodels)/i.test(c) }
  if (READ_CMD.test(c)) {
    const arg = c.split(/\s+/).filter((w) => !w.startsWith('-') && !/^\d+(,\d+)?p?$/.test(w)).pop()
    return { type: 'read-file', file: arg ? base(arg.replace(/['"]/g, '')) : '' }
  }
  if (BROWSE_CMD.test(c)) return { type: 'browse' }
  return { type: 'run-command', cmd: c.split(/\s+/)[0] ?? '' }
}

export function classifyTool(part: ToolLike, projectDir?: string): ToolAction {
  const tool = part.tool.toLowerCase()
  const i = obj(part.input)
  if (tool === 'question') return { type: 'clarify' }
  if (tool === 'bash') return classifyBash(str(i.command) ?? firstLine(part.detail ?? ''))
  if (tool === 'read') {
    const f = targetFile(part, projectDir)
    if (/(^|\/)paper\.pdf$/i.test(f) || /\.pdf\b/i.test(f)) return { type: 'read-paper', page: pageOf(part.detail, str(i.pages), str(i.page)) ?? (typeof i.page === 'number' ? i.page : undefined) }
    if (base(f) === 'program.json') return { type: 'read-study' }
    return { type: 'read-file', file: base(f) }
  }
  if (tool === 'write' || tool === 'edit' || tool === 'patch' || tool === 'multiedit') {
    const f = targetFile(part, projectDir)
    if (base(f) === 'program.json') return { type: 'write-study' }
    if (/^(artifacts|exports)\//.test(f)) return { type: 'write-result', rel: f, create: tool === 'write' }
    if (/^package\//.test(f)) return { type: 'write-package', rel: f }
    return { type: 'write-file', rel: f }
  }
  if (tool === 'glob' || tool === 'grep' || tool === 'list' || tool === 'ls' || tool === 'find') return { type: 'browse' }
  if (tool === 'webfetch') {
    const url = str(i.url) ?? firstLine(part.detail ?? '')
    let host = url
    try {
      host = new URL(url).host
    } catch {
      host = url.replace(/^https?:\/\//, '').split('/')[0]
    }
    return { type: 'open-web', host: host || url }
  }
  if (tool === 'websearch' || tool === 'codesearch') return { type: 'search-web', query: str(i.query) ?? (firstLine(part.detail ?? '') || undefined) }
  if (tool === 'task') return { type: 'delegate' }
  if (tool === 'todowrite' || tool === 'todoread') return { type: 'plan' }
  if (tool === 'skill') return { type: 'use-skill', name: str(i.name) ?? firstLine(part.detail ?? '') }
  return { type: 'other', tool: part.tool }
}

export interface Sentence {
  /** i18n key (tool.*) */
  key: string
  vars?: Record<string, string | number>
  /** Muted trailing text: the raw tool name for things we could not explain. */
  muted?: string
}

/** `titleOf` turns a result file path into its human title when known (else the de-slugged name). */
export function toolSentence(a: ToolAction, titleOf?: (rel: string) => string | undefined): Sentence {
  switch (a.type) {
    case 'clarify': return { key: 'tool.clarifying' }
    case 'simulate': return { key: 'tool.simulating' }
    case 'read-paper':
      return a.page ? { key: 'tool.reading_paper_page', vars: { page: a.page } } : { key: 'tool.reading_paper' }
    case 'read-study':
      return { key: 'tool.reading_study' }
    case 'read-file':
      return a.file ? { key: 'tool.reading_file', vars: { name: a.file } } : { key: 'tool.looking' }
    case 'write-study':
      return { key: 'tool.updating_study' }
    case 'write-result': {
      const title = titleOf?.(a.rel) ?? deSlug(a.rel)
      return { key: a.create ? 'tool.creating' : 'tool.updating', vars: { title } }
    }
    case 'write-package':
      return { key: 'tool.writing_package' }
    case 'write-file':
      return { key: 'tool.writing_file', vars: { name: base(a.rel) } }
    case 'browse':
      return { key: 'tool.looking' }
    case 'check-package':
      return { key: 'tool.checking_package' }
    case 'run-python':
      return { key: a.analysis ? 'tool.running_script' : 'tool.working' }
    case 'install':
      return { key: 'tool.installing' }
    case 'make-folder':
      return { key: 'tool.folders' }
    case 'run-command':
      return { key: 'tool.running_command' }
    case 'open-web':
      return { key: 'tool.opening', vars: { host: a.host } }
    case 'search-web':
      return { key: 'tool.searching' }
    case 'delegate':
      return { key: 'tool.delegating' }
    case 'plan':
      return { key: 'tool.planning' }
    case 'use-skill':
      return { key: a.name === 'build' ? 'tool.updating_study' : a.name === 'simulate' ? 'tool.checking_package' : 'tool.skill' }
    default:
      return { key: 'tool.working' }
  }
}

/** Every key toolSentence can return (the parity test checks they exist in both dictionaries). */
export const TOOL_KEYS = [
  'tool.reading_paper', 'tool.reading_paper_page', 'tool.reading_study', 'tool.reading_file', 'tool.updating_study', 'tool.creating',
  'tool.updating', 'tool.writing_package', 'tool.writing_file', 'tool.looking', 'tool.checking_package', 'tool.running_script',
  'tool.installing', 'tool.folders', 'tool.running_command', 'tool.opening', 'tool.searching', 'tool.delegating', 'tool.planning',
  'tool.skill', 'tool.working', 'tool.simulating', 'tool.clarifying',
] as const

/** A broad stage inferred from visible activity, never a claim about hidden reasoning. */
export function researchActivity(parts: ToolLike[], projectDir?: string): Sentence {
  const last = parts[parts.length - 1]
  if (!last) return { key: 'activity.thinking' }
  const action = classifyTool(last, projectDir)
  if (last.state === 'pending' || last.state === 'running') return toolSentence(action)
  if (action.type === 'read-paper' || action.type === 'read-study') return { key: 'activity.design' }
  if ((action.type === 'run-python' && action.analysis) || action.type === 'simulate') return { key: 'activity.results' }
  if (action.type === 'write-study' || action.type === 'check-package') return { key: 'activity.review' }
  return { key: 'activity.thinking' }
}
