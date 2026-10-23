// Research capture for the headless OpenCode worker, on the desktop's own collector and agent adapter.
// Headless has no UI: clicks, shortcuts, menus, navigation and layout are explicitly not applicable.
// The worker launch and each JSON-lines command are the primary actions; the turn, answers, tool calls
// and versions they cause link to them exactly as on desktop. Used by opencode-assets.mjs and its tests.
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'

export const HEADLESS_NOT_APPLICABLE = ['interaction:ui-click', 'interaction:ui-shortcut', 'interaction:ui-menu', 'navigation', 'selection_layout']

export async function startHeadlessResearch({ research, createResearchAgent, project, projectId, model, provider, auto }) {
  const inside = file => { const distance = relative(project, realpathSync(file)); return !distance.startsWith('..') && !isAbsolute(distance) }
  const agent = createResearchAgent((event, context) => research.capture(event, context))
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
      else if (entry.isFile()) await research.queueSource(file, projectId, file.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream', atLaunch)
    }
  }
  if (existsSync(join(project, 'paper.pdf')) && inside(join(project, 'paper.pdf'))) await research.queueSource(join(project, 'paper.pdf'), projectId, 'application/pdf', atLaunch)
  if (existsSync(join(project, 'sources'))) await collect(join(project, 'sources'))
  let artifactChain = Promise.resolve()
  // Versions found at launch are the baseline; later ones link to the tool call (or turn) that wrote them.
  const captureArtifacts = (baseline = false) => {
    const link = rel => () => baseline ? atLaunch : agent.versionLink(project, rel, 'agent-or-external')
    artifactChain = artifactChain.then(async () => {
      if (existsSync(join(project, 'program.json')) && inside(join(project, 'program.json'))) await research.queueArtifact(join(project, 'program.json'), projectId, 'program.json', 'agent-or-external', link('program.json'))
      async function walk(rel) {
        if (!inside(join(project, rel))) return
        for (const entry of readdirSync(join(project, rel), { withFileTypes: true })) {
          if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
          const child = rel + '/' + entry.name
          if (entry.isDirectory()) await walk(child)
          else if (entry.isFile()) await research.queueArtifact(join(project, child), projectId, child, 'agent-or-external', link(child))
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
