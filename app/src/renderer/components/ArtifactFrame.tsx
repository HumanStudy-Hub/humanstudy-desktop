import { useEffect, useRef } from 'react'
import type { ProjectEntry } from '../../preload/types'
import { dispatchBridge, listenToArtifact, type OpenSourceRequest } from '../bridge'
import { captureArtifactDwell } from '../capture'
import { track } from '../telemetry'

export interface ArtifactStudy {
  id?: string
  revision?: string
}

export function ArtifactFrame({ file, revision, study, active = true, src, title, className, onSource }: {
  file: ProjectEntry
  revision?: string
  study?: ArtifactStudy
  active?: boolean
  src: string
  title: string
  className: string
  onSource?(request: OpenSourceRequest): void
}) {
  const frame = useRef<HTMLIFrameElement>(null)
  const sourceHandler = useRef(onSource)
  sourceHandler.current = onSource
  const artifactRevision = revision ?? file.version ?? (file.mtime === undefined ? 'unversioned' : String(file.mtime))
  const projectDir = file.path.slice(0, -file.rel.length - 1)
  const { id: studyId, revision: studyRevision } = study ?? {}

  useEffect(() => {
    const metadata = { artifact_revision: artifactRevision, study_id: studyId ?? null, study_revision: studyRevision ?? null }
    const endDwell = active ? captureArtifactDwell(durationMs => {
      track('artifact.dwell', { target: file.rel, durationMs, artifactProjectDir: projectDir, metadata, v1Only: true })
    }) : undefined
    const unlisten = listenToArtifact(() => frame.current, msg => {
      if (!active || document.visibilityState !== 'visible') return
      if (msg.type === 'hs.interact') {
        const { type: _type, ...interaction } = msg
        track('artifact.interact', { target: file.rel, artifactProjectDir: projectDir, metadata: { ...metadata, interaction }, v1Only: true })
      } else if (msg.type === 'hs.openSource' && sourceHandler.current) sourceHandler.current(msg)
      else dispatchBridge(msg)
    })
    return () => {
      unlisten()
      endDwell?.()
    }
  }, [file.rel, projectDir, artifactRevision, studyId, studyRevision, active, src])

  return <iframe ref={frame} className={className} src={src} sandbox="allow-scripts" title={title} />
}
