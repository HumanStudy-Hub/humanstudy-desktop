import { useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react'
import ProgramDocument, { viewStudies, type ProgramDocumentProps } from '../program/ProgramDocument'
import { validateHumanProgram } from '../../shared/human-program'
import type { ProjectFile, ProjectSnapshot } from '../../preload/types'
import { track } from '../telemetry'

interface Props extends Pick<ProgramDocumentProps, 'selectedIds' | 'onPick' | 'onSource' | 'onAsk'> {
  project: ProjectSnapshot
}

export function ArtifactPanel({ project, ...docProps }: Props) {
  const [tab, setTabState] = useState('protocol')
  const setTab = (id: string) => {
    if (id !== tab) {
      const file = project.artifacts.find((a) => a.path === id)
      track('tab.switch', { target: file ? `artifacts/${file.name}` : id })
    }
    setTabState(id)
  }
  const { program, error } = useMemo(() => {
    if (!project.program) return { program: null, error: project.programError }
    try {
      return { program: validateHumanProgram(project.program), error: undefined }
    } catch (e) {
      return { program: null, error: `program.json is not a valid Human Program: ${String(e)}` }
    }
  }, [project.program, project.programError])
  const studies = program ? viewStudies(program) : []
  const [studyId, setStudyId] = useState('')
  const study = studies.find((st) => st.id === studyId)?.id ?? studies[0]?.id ?? ''
  const viewable = project.artifacts.filter((a) => ['html', 'htm', 'md', 'txt', 'png', 'jpg', 'jpeg', 'svg', 'json'].includes(a.ext))
  const active = viewable.find((a) => a.path === tab)

  useEffect(() => {
    if (tab !== 'protocol' && tab !== 'exports' && !active) setTabState('protocol')
  }, [tab, active])

  return (
    <section className="artifacts">
      <nav className="tabs">
        <Tab id="protocol" tab={tab} setTab={setTab}>Protocol</Tab>
        {viewable.map((a) => (
          <Tab key={a.path} id={a.path} tab={tab} setTab={setTab}>{prettyName(a.name)}</Tab>
        ))}
        <Tab id="exports" tab={tab} setTab={setTab}>
          Exports{project.exports.length ? ` · ${project.exports.length}` : ''}
        </Tab>
      </nav>
      <div className="tab-body">
        {tab === 'protocol' &&
          (program ? (
            <div className="doc-scroll">
              {studies.length > 1 && (
                <select
                  className="study-select"
                  value={study}
                  onChange={(e) => {
                    track('program.study_select', { target: e.target.value })
                    setStudyId(e.target.value)
                  }}
                >
                  {studies.map((st) => (
                    <option key={st.id} value={st.id}>{st.title ?? st.id}</option>
                  ))}
                </select>
              )}
              <ProgramDocument program={program} studyId={study} {...docProps} />
            </div>
          ) : (
            <Empty
              title={error ? 'program.json could not be read' : 'No protocol yet'}
              body={error ?? 'Ask the agent to build the Human Program from paper.pdf. The protocol appears here as soon as program.json is written.'}
            />
          ))}
        {active && <ArtifactView file={active} />}
        {tab === 'exports' && <Exports files={project.exports} />}
      </div>
    </section>
  )
}

function Tab({ id, tab, setTab, children }: { id: string; tab: string; setTab(id: string): void; children: ReactNode }) {
  return (
    <button className={`tab ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>
      {children}
    </button>
  )
}

function ArtifactView({ file }: { file: ProjectFile }) {
  const [text, setText] = useState<string | null>(null)
  const isText = ['md', 'txt', 'json'].includes(file.ext)
  useEffect(() => {
    if (!isText) return
    setText(null)
    fetch(file.url).then((r) => r.text()).then(setText).catch((e: unknown) => setText(String(e)))
  }, [file.url, isText])

  if (file.ext === 'html' || file.ext === 'htm')
    return <iframe className="artifact-frame" src={file.url} sandbox="allow-scripts" title={file.name} />
  if (isText) return <pre className="artifact-text">{text ?? 'Loading…'}</pre>
  return (
    <div className="artifact-image">
      <img src={file.url} alt={file.name} />
    </div>
  )
}

function Exports({ files }: { files: ProjectFile[] }) {
  if (!files.length)
    return <Empty title="Nothing exported yet" body="Ask the agent to export a preregistration, a replication package or a methods section. Files land in exports/." />
  return (
    <ul className="file-list">
      {files.map((f) => (
        <li key={f.path}>
          <span className="ext">{f.ext || 'file'}</span>
          <span className="file-name">{f.name}</span>
          <button className="link" onClick={() => window.humanstudy.project.reveal(f.path)}>Show in Finder</button>
        </li>
      ))}
    </ul>
  )
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty-state">
      <h2>{title}</h2>
      <p className="muted">{body}</p>
    </div>
  )
}

const prettyName = (n: string) =>
  n.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
