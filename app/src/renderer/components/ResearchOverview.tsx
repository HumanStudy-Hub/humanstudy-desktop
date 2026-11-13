import { useEffect, useId, useMemo, useState } from 'react'
import type { HumanProgram, ProgramEvidence, ProgramField, ProgramNode, ProgramStep } from '../../shared/human-program'
import { programText } from '../../shared/human-program'
import { prepareExperimentPrompt, scholarlyArmIds, scholarlyProblems, scholarlyProfile } from '../../shared/scholarly-program'
import type { SourceRef } from '../../shared/program-view'
import './research-overview.css'

const overviewGroups = [
  { title: 'Research question and motivation', kinds: ['background', 'question', 'research-question', 'motivation'] },
  { title: 'Paper summary', kinds: ['overview'] },
  { title: 'Hypotheses', kinds: ['hypothesis'] },
  { title: 'Main findings', kinds: ['finding'] },
]
const overviewKinds = new Set(overviewGroups.flatMap(group => group.kinds))
const detailGroups = [
  { title: 'Design and conditions', kinds: ['design', 'participants', 'condition'] },
  { title: 'Materials and procedure', kinds: ['material', 'procedure'] },
  { title: 'Variables and analysis', kinds: ['variable', 'record', 'analysis'] },
  { title: 'Reported results', kinds: ['result'] },
  { title: 'Limitations', kinds: ['limitation'] },
]

type ProtocolArm = { id: string; runnable?: boolean; why?: string }

export function ResearchOverview({ program, text, problems: documentProblems = [], onSource, onAsk }: { program: HumanProgram; text: string; problems?: string[]; onSource(ref: SourceRef): void; onAsk?(text: string): void }) {
  const anchorPrefix = useId()
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

  const studiesById = new Map(program.studies.map(study => [study.id, study]))
  const studyNames = (ids: string[]) => ids.map(id => studiesById.get(id)?.title ?? id).join(', ')
  const nodesFor = (studyId: string | null | undefined) => program.nodes.flatMap(node => {
    const matches = (ids: string[]) => {
      const known = ids.every(id => studiesById.has(id))
      if (studyId === undefined) return !known
      return known && (studyId === null ? ids.length !== 1 : ids.length === 1 && ids[0] === studyId)
    }
    const fields = node.fields.filter(field => matches(field.studyIds?.length ? field.studyIds : node.studyIds))
    const nodeHere = matches(node.studyIds)
    if (!fields.length && !(nodeHere && (!node.fields.length || node.summary || node.description))) return []
    return [{ ...node, fields, summary: nodeHere ? node.summary : undefined, description: nodeHere ? node.description : undefined }]
  })
  const stepsById = new Map(program.steps.map(step => [step.id, step]))
  const nodesById = new Map(program.nodes.map(node => [node.id, node]))
  const nodeNames = (ids: string[]) => ids.map(id => nodesById.get(id)?.title ?? id).join(', ')
  const paperNodes = nodesFor(null)
  const unassigned = nodesFor(undefined)

  const drawSources = (ids: string[]) => {
    const entries = [...new Set(ids)].map(id => evidenceById.get(id))
      .filter((item): item is ProgramEvidence => Boolean(item))
    return entries.length > 0 && <details className="research-evidence">
      <summary>Source evidence ({entries.length})</summary>
      <ul>{entries.map(drawEvidence)}</ul>
    </details>
  }
  const drawField = (field: ProgramField, fallbackEvidence: string[], showLabel = true, scope?: string) =>
    <div key={field.id} className="research-claim">
      {showLabel && <strong>{field.label}</strong>}
      {scope && <p className="muted">Applies to {scope}</p>}
      {field.value !== null && <p>{programText(field.value)}</p>}
      {field.state === 'missing' && <span className="muted">{field.extensions?.gapReason === 'source_unavailable' ? 'Source needed' : 'Not reported in the available source'}</span>}
      {field.origin === 'derived' && field.derivation && <span className="muted">Interpretation · {field.derivation}</span>}
      {drawSources(field.evidenceIds.length ? field.evidenceIds : fallbackEvidence)}
    </div>

  const draw = (node: ProgramNode, showScope = false) => {
    const sharedScope = showScope && node.studyIds.length > 1
      && (!node.fields.length || node.summary || node.description || node.fields.every(field => !field.studyIds?.length))
    const fieldSourceIds = new Set(node.fields.flatMap(field => field.evidenceIds.length ? field.evidenceIds : node.evidenceIds))
    const noteSourceIds = node.evidenceIds.filter(id => !fieldSourceIds.has(id))
    return <section key={node.id} className="research-section">
      <h4>{node.title}</h4>
      {sharedScope && <p className="muted">Applies to {studyNames(node.studyIds)}</p>}
      {node.summary && <p>{node.summary}</p>}
      {node.description && node.description !== node.summary && <p>{node.description}</p>}
      {node.fields.map(field => {
        const ids = field.studyIds?.length ? field.studyIds : node.studyIds
        return drawField(field, node.evidenceIds, node.fields.length !== 1 || field.label.trim() !== node.title.trim(),
          showScope && ids.length > 1 && (!sharedScope || field.studyIds?.length) ? studyNames(ids) : undefined)
      })}
      {drawSources(noteSourceIds)}
    </section>
  }

  const drawOverview = (nodes: ProgramNode[], showScope = false) => overviewGroups.map((group, index) => {
    const entries = nodes.filter(node => group.kinds.includes(node.kind))
    return entries.length > 0 && <div key={group.title} id={showScope ? `${anchorPrefix}-overview-${index}` : undefined} tabIndex={showScope ? -1 : undefined} className="research-overview-topic">
      <h3>{group.title}</h3>
      {entries.map(node => draw(node, showScope))}
    </div>
  })
  const drawGroups = (nodes: ProgramNode[], showScope = false) => {
    const details = nodes.filter(node => !overviewKinds.has(node.kind))
    const other = details.filter(node => !detailGroups.some(group => group.kinds.includes(node.kind)))
    return [
      ...detailGroups.map(group => ({ title: group.title, entries: details.filter(node => group.kinds.includes(node.kind)) })),
      { title: 'Additional notes', entries: other },
    ].map(({ title, entries }) => entries.length > 0 &&
      <details key={title} className="research-group"><summary>{title}</summary>{entries.map(node => draw(node, showScope))}</details>)
  }
  const drawSteps = (steps: ProgramStep[]) => steps.length > 0 && <details className="research-group">
    <summary>Experiment flow</summary>
    <ul className="research-steps">
      {steps.map(step => <li key={step.id}>
        <strong>{step.title}</strong>
        {step.conditionIds?.length ? <p>Conditions · {nodeNames(step.conditionIds)}</p> : null}
        {step.actorIds.length > 0 && <p>Actors · {nodeNames(step.actorIds)}</p>}
        {step.inputIds.length > 0 && <p>Inputs · {nodeNames(step.inputIds)}</p>}
        {step.outputIds.length > 0 && <p>Outputs · {nodeNames(step.outputIds)}</p>}
        {step.visibleIds.length > 0 && <p>Visible information · {nodeNames(step.visibleIds)}</p>}
        {step.children.length > 0 && <p>Contains · {step.children.map(id => stepsById.get(id)?.title ?? id).join(', ')}</p>}
        {step.next.map(edge => <p key={edge.to}>Next · {stepsById.get(edge.to)?.title ?? edge.to}{edge.when && ` (${edge.when})`}</p>)}
        {step.rule && drawField(step.rule, [])}
        {drawSources(step.evidenceIds)}
      </li>)}
    </ul>
  </details>

  const arms: ProtocolArm[] = Array.isArray(protocol?.arms) ? protocol.arms.filter((arm: ProtocolArm | null) => typeof arm?.id === 'string') : []

  const overviewLinks = overviewGroups.flatMap((group, index) =>
    paperNodes.some(node => group.kinds.includes(node.kind))
      ? [{ id: `${anchorPrefix}-overview-${index}`, title: group.title }] : [])
  const experimentLinks = program.studies.map((study, index) => ({ id: `${anchorPrefix}-experiment-${index}`, title: study.title }))
  const links = (entries: typeof overviewLinks) => <ul>
    {entries.map(({ id, title }) => <li key={id}><a href={`#${id}`} onClick={event => {
      event.preventDefault()
      const target = document.getElementById(id)
      if (!target) return
      if (target instanceof HTMLDetailsElement) target.open = true
      const disclosure = event.currentTarget.closest('details')
      if (disclosure) disclosure.open = false
      const focus = target instanceof HTMLDetailsElement ? target.querySelector('summary') : target
      focus?.focus({ preventScroll: true })
      target.scrollIntoView({ block: 'start' })
    }}>{title}</a></li>)}
  </ul>
  const contents = <>
    {overviewLinks.length > 0 && <div><strong>Overview</strong>{links(overviewLinks)}</div>}
    {experimentLinks.length > 0 && <div><strong>Experiments and analyses</strong>{links(experimentLinks)}</div>}
  </>

  return <article className="research-overview">
    <div className="research-reading-layout">
      {(overviewLinks.length > 0 || experimentLinks.length > 0) && <nav className="research-reading-contents" aria-label="Study contents">
        <div className="research-reading-rail">{contents}</div>
        <details className="research-reading-compact"><summary>Contents</summary>{contents}</details>
      </nav>}
      <div className="research-reading-body">
        <h1>{program.title}</h1>
        {program.source.authors && <p className="muted research-citation">{program.source.authors}</p>}
        {!bound && <p className="research-notice" role="status">Research notes are readable, but have not been checked against this experiment.</p>}
        {problems.length > 0 && <details className="research-notice"><summary>Research notes need checking</summary><ul>{problems.map(problem => <li key={problem}>{problem}</li>)}</ul></details>}
        {paperNodes.some(node => overviewKinds.has(node.kind)) && <section className="research-experiments">
          <h2>Overview</h2>
          {drawOverview(paperNodes, true)}
        </section>}
        {program.studies.length > 0 && <section className="research-experiments">
          <h2>Experiments and analyses</h2>
          {program.studies.map((study, index) => {
            const ids = bound ? scholarlyArmIds(program, study.id) : []
            const matchedArms = arms.filter(arm => ids.includes(arm.id))
            const blocked = matchedArms.length > 0 && matchedArms.every(arm => arm.runnable === false)
            const reasons = [...new Set(matchedArms.flatMap(arm => arm.runnable === false && typeof arm.why === 'string'
              ? [arm.why.replace(/\s+\(DESIGN[^)]*\)\.?$/, '')]
              : []).filter(Boolean))]
            const nodes = nodesFor(study.id)
            return <details className="research-experiment" id={experimentLinks[index].id} key={study.id} open={program.studies.length === 1}>
              <summary>{study.title}</summary>
              {study.description && <p>{study.description}</p>}
              {reasons.map(reason => <p key={reason} className="muted">{reason}</p>)}
              {blocked && !reasons.length && <p className="muted">Materials are needed before this experiment can run.</p>}
              {drawOverview(nodes)}
              {drawSteps(program.steps.filter(step => step.studyId === study.id))}
              {drawGroups(nodes)}
              {onAsk && study.type !== 'analysis' && <button className="ghost research-prepare" onClick={() => onAsk(prepareExperimentPrompt(study, ids))}>{blocked ? 'Review missing materials' : 'Prepare this experiment'}</button>}
            </details>
          })}
        </section>}
        {paperNodes.some(node => !overviewKinds.has(node.kind)) && <section className="research-experiments">
          <h2>Details across the paper</h2>
          {drawGroups(paperNodes, true)}
        </section>}
        {unassigned.length > 0 && <section className="research-group"><h2>Notes with unresolved study references</h2>{unassigned.map(node => draw(node))}</section>}
      </div>
    </div>
  </article>
}
