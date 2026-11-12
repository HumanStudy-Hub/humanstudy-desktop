import { useEffect, useMemo, useState } from 'react'
import type { HumanProgram, ProgramEvidence, ProgramNode } from '../../shared/human-program'
import { programText } from '../../shared/human-program'
import { prepareExperimentPrompt, scholarlyArmIds, scholarlyProblems, scholarlyProfile } from '../../shared/scholarly-program'
import type { SourceRef } from '../../shared/program-view'
import './research-overview.css'

const overviewKinds = ['background', 'finding']
const sectionGroups = [
  { title: 'Reported results', kinds: ['result'] },
  { title: 'Hypotheses and design', kinds: ['hypothesis', 'design', 'participants'] },
  { title: 'Materials and procedure', kinds: ['material', 'procedure'] },
  { title: 'Variables and analysis', kinds: ['variable', 'analysis'] },
  { title: 'Limitations', kinds: ['limitation'] },
]

type ProtocolArm = { id: string; runnable?: boolean; why?: string }

export function ResearchOverview({ program, text, problems: documentProblems = [], onSource, onAsk }: { program: HumanProgram; text: string; problems?: string[]; onSource(ref: SourceRef): void; onAsk?(text: string): void }) {
  const protocol = useMemo(() => {
    try { return JSON.parse(text) } catch { return null }
  }, [text])
  const [check, setCheck] = useState<{ text: string; program: HumanProgram; problems: string[] } | null>(null)
  useEffect(() => {
    let live = true
    void crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)).then(bytes => {
      const hash = Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('')
      const problems = !scholarlyProfile(program) ? [] : protocol ? scholarlyProblems(program, protocol, hash) : ['The experiment file cannot be read.']
      if (live) setCheck({ text, program, problems })
    }).catch(() => {
      if (live) setCheck({ text, program, problems: ['The experiment file could not be checked.'] })
    })
    return () => { live = false }
  }, [program, protocol, text])
  const problems = [...new Set([...documentProblems, ...(check?.text === text && check.program === program ? check.problems : [])])]
  const bound = Boolean(scholarlyProfile(program) && check?.text === text && check.program === program && !check.problems.length && !documentProblems.length)
  const evidenceCounts = new Map<string, number>()
  for (const item of program.evidence) evidenceCounts.set(item.id, (evidenceCounts.get(item.id) ?? 0) + 1)
  const evidenceById = new Map(program.evidence.filter(item => evidenceCounts.get(item.id) === 1).map(item => [item.id, item]))

  const drawEvidence = (evidence: ProgramEvidence) => {
    const { id, locator, path, quote, sourceId, url } = evidence
    const location = locator.page ? `Page ${locator.page}` : locator.pointer || locator.cell || 'Source excerpt'
    const hasLocalSource = Boolean(path || (!url && sourceId))
    let external: URL | undefined
    if (url) {
      try {
        const candidate = new URL(url)
        if (candidate.protocol === 'https:' && !candidate.username && !candidate.password) external = candidate
      } catch { /* The excerpt is still readable. */ }
    }
    return <li key={id}>
      <span>{location}</span>
      {quote && <blockquote>{quote}</blockquote>}
      {hasLocalSource && <button className="link research-cite" onClick={() => onSource({ file: path, sourceId, sourceSha256: evidence.sourceSha256, page: locator.page, quote: quote ?? '', verified: evidence.verification === 'verified' })}>Open source</button>}
      {external && <a href={external.href} target="_blank" rel="noreferrer">Open original source ↗</a>}
    </li>
  }

  const draw = (node: ProgramNode) => <section key={node.id} className="research-section">
    <h3>{node.title}</h3>
    {node.fields.map(field => {
      const evidence = [...new Set(field.evidenceIds.length ? field.evidenceIds : node.evidenceIds)]
        .map(id => evidenceById.get(id))
        .filter((item): item is ProgramEvidence => Boolean(item))
      return <div key={field.id} className="research-claim">
        {(node.fields.length !== 1 || field.label.trim() !== node.title.trim()) && <strong>{field.label}</strong>}
        {field.value !== null && <p>{programText(field.value)}</p>}
        {field.state === 'missing' && <span className="muted">{field.extensions?.gapReason === 'source_unavailable' ? 'Source needed' : 'Not reported in the available source'}</span>}
        {field.origin === 'derived' && <span className="muted">Interpretation · {field.derivation}</span>}
        {evidence.length > 0 && <details className="research-evidence">
          <summary>Source evidence ({evidence.length})</summary>
          <ul>{evidence.map(drawEvidence)}</ul>
        </details>}
      </div>
    })}
  </section>

  const drawGroups = (nodes: ProgramNode[]) => {
    const covered = new Set(sectionGroups.flatMap(group => group.kinds))
    const groups = [...sectionGroups, { title: 'Additional study notes', kinds: nodes.filter(node => !covered.has(node.kind)).map(node => node.kind) }]
    return groups.map(group => {
      const entries = nodes.filter(node => group.kinds.includes(node.kind))
      return entries.length > 0 ? <details key={group.title} className="research-group"><summary>{group.title}</summary>{entries.map(draw)}</details> : null
    })
  }

  const studyIds = new Set(program.studies.map(study => study.id))
  const knownScope = (ids: string[]) => ids.every(id => studyIds.has(id))
  const paperScope = (ids: string[]) => knownScope(ids) && (!ids.length || program.studies.every(study => ids.includes(study.id)))
  const overview = program.nodes.filter(node => overviewKinds.includes(node.kind) && paperScope(node.studyIds)
    && node.fields.every(field => !field.studyIds?.length || paperScope(field.studyIds)))
  const remaining = program.nodes.filter(node => !overview.includes(node))
  const scoped = (studyId: string | null) => remaining.flatMap(node => {
    const fields = node.fields.filter(field => {
      const ids = field.studyIds?.length ? field.studyIds : node.studyIds
      return studyId ? knownScope(ids) && ids.includes(studyId) : ids.length === 0
    })
    return fields.length ? [{ ...node, fields }] : []
  })
  const unassigned = remaining.flatMap(node => {
    const fields = node.fields.filter(field => !knownScope(field.studyIds?.length ? field.studyIds : node.studyIds))
    return fields.length ? [{ ...node, fields }] : []
  })
  const arms: ProtocolArm[] = Array.isArray(protocol?.arms) ? protocol.arms.filter((arm: ProtocolArm | null) => typeof arm?.id === 'string') : []

  return <article className="research-overview">
    <h1>{program.title}</h1>
    {program.source.authors && <p className="muted research-citation">{program.source.authors}</p>}
    {!bound && <p className="research-notice" role="status">Research notes are readable, but have not been checked against this experiment.</p>}
    {problems.length > 0 && <details className="research-notice"><summary>Research notes need checking</summary><ul>{problems.map(problem => <li key={problem}>{problem}</li>)}</ul></details>}
    {overview.map(draw)}
    <section className="research-experiments">
      <h2>Experiments</h2>
      {program.studies.map(study => {
        const ids = bound ? scholarlyArmIds(program, study.id) : []
        const matchedArms = arms.filter(arm => ids.includes(arm.id))
        const blocked = matchedArms.length > 0 && matchedArms.every(arm => arm.runnable === false)
        const reasons = [...new Set(matchedArms.flatMap(arm => arm.runnable === false && typeof arm.why === 'string'
          ? [arm.why.replace(/\s+\(DESIGN[^)]*\)\.?$/, '')]
          : []).filter(Boolean))]
        return <details className="research-experiment" key={study.id}>
          <summary>{study.title}</summary>
          {study.description && <p>{study.description}</p>}
          {reasons.map(reason => <p key={reason} className="muted">{reason}</p>)}
          {blocked && !reasons.length && <p className="muted">Materials are needed before this experiment can run.</p>}
          {drawGroups(scoped(study.id))}
          {onAsk && study.type !== 'analysis' && <button className="ghost research-prepare" onClick={() => onAsk(prepareExperimentPrompt(study, ids))}>{blocked ? 'Review missing materials' : 'Prepare this experiment'}</button>}
        </details>
      })}
    </section>
    {drawGroups(scoped(null))}
    {unassigned.length > 0 && <section className="research-group"><h2>Notes with unresolved study references</h2>{unassigned.map(draw)}</section>}
  </article>
}
