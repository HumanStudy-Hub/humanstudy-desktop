import { useEffect, useState } from 'react'
import type { HumanProgram, ProgramNode } from '../../shared/human-program'
import { programText } from '../../shared/human-program'
import { prepareExperimentPrompt, scholarlyArmIds, scholarlyProblems, scholarlyProfile } from '../../shared/scholarly-program'
import type { SourceRef } from '../../shared/program-view'

export function ResearchOverview({ program, text, onSource, onAsk }: { program: HumanProgram; text: string; onSource(ref: SourceRef): void; onAsk?(text: string): void }) {
  const [check, setCheck] = useState<{ text: string; program: HumanProgram; problems: string[] } | null>(null)
  useEffect(() => {
    let live = true
    void crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)).then(bytes => {
      const hash = Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('')
      let problems: string[]
      try { problems = scholarlyProblems(program, JSON.parse(text), hash) } catch { problems = ['The experiment file cannot be read.'] }
      if (live) setCheck({ text, program, problems })
    })
    return () => { live = false }
  }, [program, text])
  const current = check?.text === text && check.program === program ? check : null
  const draw = (node: ProgramNode) => <section key={node.id} className="research-section">
    <h3>{node.title}</h3>
    {node.fields.map(field => <div key={field.id} className="research-claim">
      <p>{programText(field.value)}</p>
      {field.state === 'missing' && <span className="muted">{field.extensions?.gapReason === 'source_unavailable' ? 'Source needed' : 'Not reported in the available source'}</span>}
      {field.origin === 'derived' && <span className="muted">Interpretation · {field.derivation}</span>}
      {[...new Set(field.evidenceIds)].map(id => {
        const e = program.evidence.find(item => item.id === id)
        return e ? <button key={id} className="link research-cite" onClick={() => onSource({ file: e.path, page: e.locator.page ?? 1, quote: e.quote ?? '', verified: false })}>p. {e.locator.page ?? '—'}</button> : null
      })}
    </div>)}
  </section>
  let protocol: any = null
  try { protocol = JSON.parse(text) } catch { /* overview is still available */ }
  return <article className="research-overview">
    <h1>{program.title}</h1>
    <p className="muted research-citation">{program.source.authors} · Research draft</p>
    {scholarlyProfile(program) && current && current.problems.length > 0 && <p role="status" className="research-notice">Research notes need checking: {current.problems.join(' ')} Existing notes are kept below.</p>}
    {program.nodes.filter(n => ['background', 'hypothesis', 'finding'].includes(n.kind)).map(draw)}
    <div className="research-experiments">{program.studies.map(study => {
      const ids = scholarlyArmIds(program, study.id)
      const arms = (Array.isArray(protocol?.arms) ? protocol.arms : []).filter((a: any) => ids.includes(a.id))
      const blocked = arms.length > 0 && arms.every((a: any) => a.runnable === false)
      const reasons = [...new Set<string>(arms.filter((a: any) => a.runnable === false && typeof a.why === 'string').map((a: any) => a.why.replace(/\s+\(DESIGN[^)]*\)\.?$/, '')))]
      return <section key={study.id}>
        <div><h3>{study.title}</h3><p>{study.description}</p>
          {reasons.map(reason => <p key={reason} className="muted">{reason}</p>)}
          {blocked && !reasons.length && <p className="muted">Materials are needed before this experiment can run.</p>}
        </div>
        {onAsk && study.type !== 'analysis' && <button className="ghost" onClick={() => onAsk(prepareExperimentPrompt(study, ids))}>{blocked ? 'Review missing materials' : 'Prepare this experiment'}</button>}
      </section>
    })}</div>
    <details><summary>Study details and reported results</summary>{program.nodes.filter(n => !['background', 'hypothesis', 'finding'].includes(n.kind)).map(draw)}</details>
  </article>
}
