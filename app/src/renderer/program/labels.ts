// Human-readable names for program item ids (nodes, and `flow:<stepId>` for steps), used by the
// selection chips and the context line sent to the agent. Works on the raw program.json object.
export interface SelectedItem {
  id: string
  title: string
}

type Loose = { nodes?: { id?: string; title?: string }[]; steps?: { id?: string; title?: string }[] }

export function itemTitle(program: unknown, id: string): string {
  const p = (program ?? {}) as Loose
  if (id.startsWith('flow:')) {
    const step = p.steps?.find((s) => s.id === id.slice(5))
    return step?.title ?? id
  }
  return p.nodes?.find((n) => n.id === id)?.title ?? id
}

export function labelItems(program: unknown, ids: string[]): SelectedItem[] {
  return ids.map((id) => ({ id, title: itemTitle(program, id) }))
}

/** The context block that precedes a message about selected items. */
export function selectionContext(items: SelectedItem[]): string {
  if (!items.length) return ''
  return `[Selected study items]\n${items.map((i) => `- ${i.id} — ${i.title}`).join('\n')}\n\n`
}
