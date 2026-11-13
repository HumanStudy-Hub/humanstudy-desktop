export type PaperHandoff = { paper: string; revision: string; intent: 'read' | 'run' }

export function readPaperHandoff(search: string): PaperHandoff | null {
  const params = new URLSearchParams(search)
  const paper = params.get('paper'), revision = params.get('revision'), intent = params.get('intent')
  if (!paper || !/^paper_[a-f0-9]{24}$/.test(paper) || !revision || !/^[a-f0-9]{64}$/.test(revision)
    || (intent !== null && intent !== 'read' && intent !== 'run')) return null
  return { paper, revision, intent: intent === 'run' ? 'run' : 'read' }
}

export function assertPaperRevision(current: string | null | undefined, expected?: string): void {
  if (expected !== undefined && (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected) || expected !== current)) {
    throw new Error('This paper has a different published version. Return to the library to choose the current version. No project was created.')
  }
}
