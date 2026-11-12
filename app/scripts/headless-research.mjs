// Research capture for the headless OpenCode worker, on the desktop's own collector and agent adapter.
// Headless has no UI: clicks, shortcuts, menus, navigation and layout are explicitly not applicable.
// The worker launch and each JSON-lines command are the primary actions; the turn, answers, tool calls
// and versions they cause link to them exactly as on desktop. Used by opencode-assets.mjs and its tests.
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, realpathSync, lstatSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'

export const HEADLESS_NOT_APPLICABLE = ['interaction:ui-click', 'interaction:ui-shortcut', 'interaction:ui-menu', 'navigation', 'selection_layout']

/** One guard owns both capture and delivery. A privacy stop latches across restarts of the project. */
export function createHeadlessResearchGuard({ project, PRIVATE_MATERIAL, marker, onRestricted }) {
  const abort = new AbortController()
  const reason = 'The headless worker cannot verify private or held wording. Capture and delivery are paused for this project. Open it in HumanStudy Desktop.'
  let protocolStamp = '', distribution
  function protectedTree(dir, rel) {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch (error) {
      if (error.code === 'ENOENT') return false
      throw error
    }
    for (const entry of entries) {
      const path = rel + '/' + entry.name
      // An alias can hide a protected target from path checks. Never follow it in headless.
      if (entry.isSymbolicLink() || PRIVATE_MATERIAL.test(path + '/')) return true
      if (entry.isDirectory() && protectedTree(join(dir, entry.name), path)) return true
    }
    return false
  }
  function inspect() {
    if (marker) {
      try { lstatSync(marker); return null } catch (error) {
        if (error.code !== 'ENOENT') return null
      }
    }
    const sources = join(project, 'sources')
    try {
      if (lstatSync(sources).isSymbolicLink() || protectedTree(sources, 'sources')) return null
    } catch (error) {
      if (error.code !== 'ENOENT') return null
    }
    const protocol = join(project, 'protocol.json')
    let stat
    try { stat = lstatSync(protocol) } catch (error) {
      if (error.code !== 'ENOENT') return null
    }
    if (!stat) {
      protocolStamp = ''
      distribution = undefined
    } else {
      if (!stat.isFile()) return null
      const stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
      if (stamp !== protocolStamp) {
        try {
          const parsed = JSON.parse(readFileSync(protocol, 'utf8'))
          const object = value => value && typeof value === 'object' && !Array.isArray(value)
          if (!object(parsed)) return null
          distribution = parsed.distribution
          if (distribution !== undefined && (!object(distribution) ||
              (distribution.held !== undefined && !object(distribution.held)))) return null
          protocolStamp = stamp
        } catch { return null }
      }
    }
    return Object.keys(distribution?.held ?? {}).length ? null : { published: Boolean(distribution) }
  }
  function scope() {
    if (abort.signal.aborted) return null
    const current = inspect()
    if (current) return current
    abort.abort(new Error(reason))
    let notice = reason
    try {
      if (marker) writeFileSync(marker, 'Research capture and delivery stopped for privacy review.\n', { mode: 0o600, flag: 'wx' })
    } catch (error) {
      if (error.code !== 'EEXIST') notice += ' The local stop marker could not be saved.'
    }
    onRestricted?.(notice)
    return null
  }
  return { scope, signal: abort.signal, reason }
}

export async function startHeadlessResearch({ research, createResearchAgent, privacy, guard, project, projectId, model, provider, auto }) {
  const { EMPTY_INDEX, mayCollectFile, redactCapture } = privacy
  const captureScope = guard.scope
  if (!captureScope()) throw Error(guard.reason)
  function allowedFile(rel) {
    const current = captureScope()
    return current && mayCollectFile({ rel, published: current.published, index: EMPTY_INDEX })
  }
  const artifactFilter = text => {
    const current = captureScope()
    if (!current) return null
    if (text === undefined) return undefined
    return redactCapture({ metadata: { file: text } }, EMPTY_INDEX, current.published).metadata.file
  }
  const inside = file => { const distance = relative(project, realpathSync(file)); return !distance.startsWith('..') && !isAbsolute(distance) }
  const agent = createResearchAgent((event, context) => {
    const current = captureScope()
    return current ? research.capture(redactCapture(event, EMPTY_INDEX, current.published), context) : Promise.resolve(null)
  })
  const headless = { view: 'headless', project_id: projectId }
  const launch = { id: randomUUID(), target: 'command.start', via: 'system' }
  agent.action(launch, { ...headless, dir: project, metadata: { input_route: 'cli', ui_actions: 'not_applicable', provider, model, auto } })
  const atLaunch = agent.sourceLink(launch, 'baseline')
  async function collect(dir) {
    if (!inside(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
      const file = join(dir, entry.name)
      if (entry.isDirectory()) await collect(file)
      else if (entry.isFile() && allowedFile(relative(project, file)))
        await research.queueSource(file, projectId, file.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream', atLaunch)
    }
  }
  if (existsSync(join(project, 'paper.pdf')) && inside(join(project, 'paper.pdf')) && allowedFile('paper.pdf'))
    await research.queueSource(join(project, 'paper.pdf'), projectId, 'application/pdf', atLaunch)
  if (existsSync(join(project, 'sources'))) await collect(join(project, 'sources'))
  let artifactChain = Promise.resolve()
  // Versions found at launch are the baseline; later ones link to the tool call (or turn) that wrote them.
  const captureArtifacts = (baseline = false) => {
    const link = rel => () => baseline ? atLaunch : agent.versionLink(project, rel, 'agent-or-external')
    // program.json is read and linked now, when its writer finished: a later checkpoint may replace
    // it before this capture's turn in the queue comes.
    const snapshots = []
    for (const rel of ['program.json', 'protocol.json', 'study.json']) {
      const path = join(project, rel)
      try {
        if (existsSync(path) && inside(path) && allowedFile(rel))
          snapshots.push({ path, rel, text: readFileSync(path, 'utf8'), writer: link(rel)() })
      } catch { /* a write in progress can be observed after its next checkpoint */ }
    }
    artifactChain = artifactChain.then(async () => {
      for (const { path, rel, text, writer } of snapshots) if (allowedFile(rel))
        await research.queueArtifact(path, projectId, rel, 'agent-or-external', writer, text, artifactFilter)
      async function walk(rel) {
        if (!inside(join(project, rel))) return
        for (const entry of readdirSync(join(project, rel), { withFileTypes: true })) {
          if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
          const child = rel + '/' + entry.name
          if (entry.isDirectory()) await walk(child)
          else if (entry.isFile() && allowedFile(child))
            await research.queueArtifact(join(project, child), projectId, child, 'agent-or-external', link(child), undefined, artifactFilter)
        }
      }
      for (const rel of ['artifacts', 'package', 'exports']) if (existsSync(join(project, rel))) await walk(rel)
    }).catch(() => {})
    return artifactChain
  }
  await captureArtifacts(true)
  return {
    agent,
    captureArtifacts,
    onSession: sid => agent.bind(sid, projectId, project, model),
    /** Every command is one primary action; its id is returned to the bridge for the request it starts. */
    onOperation(sid, request) {
      const ref = { id: randomUUID(), target: 'command.' + String(request.op).slice(0, 40), via: 'system' }
      const command = ['build', 'send'].includes(request.op) ? { ...request, text: undefined } : request
      const fields = { ...headless, thread_id: sid, metadata: { input_route: 'jsonl-command', ui_actions: 'not_applicable', command: JSON.stringify(command) } }
      if (['answer', 'reject-question'].includes(request.op)) agent.answer(sid, String(request.questionId), ref, fields)
      else if (request.op === 'permission') agent.permit(sid, String(request.permissionId), ref, fields)
      else agent.action(ref, fields)
      return ref
    },
    onRequest(sid, request, ref) { if (request.op === 'abort') agent.abort(sid, ref); else agent.start(sid, request.text, ref) },
    // Checkpoints are versioned when the call that wrote them finishes (program_io.py runs through
    // bash), not only at turn end; unchanged files are deduplicated by content hash in the collector.
    onEvent(event) { agent.event(event); if (event.type === 'done' || (event.type === 'tool' && ['completed', 'error'].includes(event.text))) void captureArtifacts() },
    async close() { await captureArtifacts(); await agent.close() },
  }
}
