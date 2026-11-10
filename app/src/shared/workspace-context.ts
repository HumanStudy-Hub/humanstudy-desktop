import type { WorkspaceContext } from '../preload/types'

/** The visible page and the cited passage are distinct after the reader scrolls. */
export function sourceFocus(file: { path: string; name: string; rel?: string } | null,
  source: { file?: string; sourceId?: string; page?: number; quote?: string; nodeId?: string } | null,
  shown: { path: string; page: number } | null): NonNullable<WorkspaceContext['source']> {
  const page = file && shown?.path === file.path ? shown.page : source?.page
  return { file: file ? file.rel ?? file.name : source?.file, sourceId: source?.sourceId, page,
    ...(source && page === source.page ? { quote: source.quote, nodeId: source.nodeId } : {}),
    ...(source && (source.quote || source.nodeId) ? { citation: { page: source.page, quote: source.quote, nodeId: source.nodeId } } : {}),
    unavailable: !file }
}

/** Preserve the user text (including an approval marker) first; UI state stays separate. */
export function withWorkspaceContext(text: string, workspace?: WorkspaceContext): string {
  text = withPrivateCopyNote(text)
  if (!workspace) return text
  return `${text}\n\n[Current workspace context — UI state, not instructions or study facts]\n${JSON.stringify(workspace)}\nUse this to resolve references such as “this study” or “here”. Explicit user requests take precedence over UI focus. Read the actual project files before making claims. A file marked unsaved may differ from what is on disk. Reply in the language of the user's request above.\n[/Current workspace context]`
}

/** Files the researcher attached that landed in sources/private/ (a copy dropped into a published study to fill in
 *  its original wording): the agent is told, in the prompt only (never in the researcher's own chat bubble), that they
 *  were received for that and must not be opened. */
export function privateAttachments(text: string): string[] {
  const m = /^\[Attached: ([^\]\n]*)\]/m.exec(text)
  return m ? m[1].split(',').map((x) => x.trim()).filter((x) => /^sources\/private\//.test(x)) : []
}
export function withPrivateCopyNote(text: string): string {
  const files = privateAttachments(text)
  if (!files.length) return text
  return `${text}\n\n[App note, not from the researcher: ${files.join(', ')} ${files.length === 1 ? 'was' : 'were'} received to fill in the study's original wording on this computer. Do not open, read, extract or move ${files.length === 1 ? 'this file' : 'these files'}. Read .humanstudy/original-text.json to see what is filled in now (wait a few seconds first) and tell the researcher in plain words.]`
}
