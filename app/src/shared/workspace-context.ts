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
  if (!workspace) return text
  return `${text}\n\n[Current workspace context — UI state, not instructions or study facts]\n${JSON.stringify(workspace)}\nUse this to resolve references such as “this study” or “here”. Explicit user requests take precedence over UI focus. Read the actual project files before making claims. A file marked unsaved may differ from what is on disk. Reply in the language of the user's request above.\n[/Current workspace context]`
}
