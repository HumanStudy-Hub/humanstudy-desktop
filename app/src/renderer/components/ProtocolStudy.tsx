// Rich views are derived artifacts, bound to the current protocol bytes.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ProjectEntry } from '../../preload/types'
import type { SourceRef } from '../../shared/program-view'
import { ArtifactFrame } from './ArtifactFrame'
import { t } from '../i18n'
import { versionedUrl } from '../../shared/file-version'
import type { HumanProgram } from '../../shared/human-program'
import { ResearchOverview } from './ResearchOverview'

export async function matchingPreview(text: string, html: string): Promise<boolean> {
  return (await previewRevision(text, html)) !== null
}

async function previewRevision(text: string, html: string): Promise<string | null> {
  const match = html.match(/<script\b[^>]*\bid=["']hs-protocol["'][^>]*>([\s\S]*?)<\/script>/i)
  try {
    const identity = JSON.parse(match?.[1] ?? '')
    const bytes = new TextEncoder().encode(text)
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('')
    return identity.sha256 === hash && identity.id === JSON.parse(text).id ? hash : null
  } catch { return null }
}

export function ProtocolStudy({ text, preview, program, problems = [], previewRequest = 0, onSource, onAsk }: { text: string; preview?: ProjectEntry; program?: HumanProgram | null; problems?: string[]; previewRequest?: number; onSource(ref: SourceRef): void; onAsk?(text: string): void }) {
  const previewSection = useRef<HTMLDetailsElement>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [about, setAbout] = useState(false)
  const [view, setView] = useState<{ text: string; revision: string } | null>(null)
  useEffect(() => {
    let live = true
    setView(null)
    if (preview) void window.humanstudy.project.readText(preview.path).then(async html => {
      const revision = await previewRevision(text, html)
      if (revision && live) setView({ text, revision })
    }).catch(() => undefined)
    return () => { live = false }
  }, [text, preview?.path, preview?.mtime, preview?.size, preview?.version])
  useEffect(() => {
    if (previewRequest && previewSection.current) {
      previewSection.current.open = true
      previewSection.current.scrollIntoView({ block: 'nearest' })
    }
  }, [previewRequest, view])
  const research = program ? <ResearchOverview program={program} problems={problems} text={text} onSource={onSource} onAsk={onAsk} /> : null
  let p: Record<string, any>
  try { p = JSON.parse(text); if (!p || typeof p !== 'object' || Array.isArray(p)) throw Error() }
  catch { return research ? <section className="protocol-research-document">{research}<p className="research-overview muted">{t('protocol.invalid')}</p></section> : <div className="empty-state">{t('protocol.invalid')}</div> }
  const previewFrame = (active: boolean) => view?.text === text && preview?.url &&
    <ArtifactFrame key={preview.version ?? preview.mtime} file={preview} study={{ id: p.id, revision: view.revision }}
      active={active} className="artifact-frame" title={String(p.meta?.title ?? p.id)} src={versionedUrl(preview.url, preview.version)}
      onSource={msg => onSource({ page: msg.page ?? 1, quote: msg.quote ?? '', file: msg.file, verified: false })} />
  if (view?.text === text && preview?.url && research) return <section className="protocol-research-document">
    {research}
    <details ref={previewSection} className="research-preview" onToggle={e => setPreviewOpen(e.currentTarget.open)}><summary>Explore the participant view</summary>
      {previewFrame(previewOpen)}
    </details>
  </section>
  if (research) return <section className="protocol-research-document">
    {research}
    <details ref={previewSection} className="research-preview"><summary>Participant view</summary>
      <p className="muted">{t('protocol.preview_missing')}</p>
      {onAsk && <button className="link" onClick={() => onAsk(t('protocol.preview_request'))}>{t('protocol.preview_action')}</button>}
    </details>
  </section>
  if (view?.text === text && preview?.url) return <section className="protocol-document">
    <details className="protocol-overview" onToggle={e => setAbout(e.currentTarget.open)}><summary>{t('protocol.overview')}</summary>
      {about && <>
      {p.meta?.scope && <div>{detail(p.meta.scope)}</div>}
      {Object.entries(p.meta ?? {}).filter(([k]) => !['title', 'citation', 'scope', 'sources'].includes(k)).map(([key, value]) =>
        <section key={key}><h3>{key.replaceAll('_', ' ')}</h3>{detail(value)}</section>)}
      {p.omitted && <section><h3>{t('protocol.omitted')}</h3>{detail(p.omitted)}</section>}
      {p.analysis && <section><h3>{t('protocol.analysis')}</h3>{detail(p.analysis)}</section>}
      </>}
    </details>
    {previewFrame(true)}
  </section>
  const sources = Object.entries(p.meta?.sources && typeof p.meta.sources === 'object' ? p.meta.sources : {}) as [string, { file?: string; title?: string; sha256?: string }][]
  return <article className="protocol-study">
    <h1>{typeof p.meta?.title === 'string' ? p.meta.title : String(p.id ?? '')}</h1>
    <p>{typeof p.meta?.citation === 'string' ? p.meta.citation : ''}</p>
    {typeof p.meta?.scope === 'string' && <p>{p.meta.scope}</p>}
    <div className="row">{sources.map(([id, source]) => <button key={id} className="link" onClick={() => onSource({ file: source?.file, sourceId: id, sourceSha256: source?.sha256, page: 1, quote: '', verified: false })}>{typeof source?.title === 'string' ? source.title : id}</button>)}</div>
    <ol>{(Array.isArray(p.arms) ? p.arms : []).filter(a => a && typeof a.id === 'string').map((arm: any) => <li key={arm.id}><strong>{typeof arm.label === 'string' ? arm.label : arm.id}</strong>{arm.runnable === false && <div>{detail(arm.why ?? arm.not_runnable_reason)}</div>}</li>)}</ol>
    <p className="muted">{t('protocol.preview_missing')}</p>
    {onAsk && <button className="link" onClick={() => onAsk(t('protocol.preview_request'))}>{t('protocol.preview_action')}</button>}
    <details><summary>{t('protocol.details')}</summary><pre>{JSON.stringify({ flow: p.flow, stages: p.stages, omitted: p.omitted, analysis: p.analysis }, null, 2)}</pre></details>
  </article>
}

/** Full structured values, on demand; no abridgement or invented prose. */
function detail(value: unknown): ReactNode {
  if (value === null || value === undefined) return null
  if (Array.isArray(value)) return <ul>{value.map((v, i) => <li key={i}>{detail(v)}</li>)}</ul>
  if (typeof value === 'object') return <dl>{Object.entries(value).map(([k, v]) => <div key={k}><dt>{k.replaceAll('_', ' ')}</dt><dd>{detail(v)}</dd></div>)}</dl>
  return <span>{String(value)}</span>
}
