import type { NativeOperation, NativeRequest, NativeSelection } from '../../shared/native'
export const segment = (value: unknown): string => {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw Error('A valid identifier is required.')
  return encodeURIComponent(value)
}
/** Only settings/credential responses are redacted. Research/file/history content stays complete. */
export function hideCredentials(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(hideCredentials)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [
      k,
      /^(api.?key|password|secret|token|access.?token|refresh.?token|authorization|client.?secret|headers|environment|env)$/i.test(
        k,
      )
        ? '[hidden]'
        : hideCredentials(v),
    ]),
  )
}
export interface NativeRoute {
  method: string
  path: string
  body?: unknown
  redact?: boolean
}
export function nativeRoute(
  sid: string,
  request: NativeRequest,
  selection: NativeSelection,
  defaults: { providerID: string; modelID: string },
): NativeRoute {
  const i = request.input ?? {},
    s = '/session/' + segment(sid),
    get = (path: string, redact = false) => ({ method: 'GET', path, redact }),
    post = (path: string, body: unknown = {}) => ({ method: 'POST', path, body }),
    del = (path: string) => ({ method: 'DELETE', path }),
    query = (v: unknown) => encodeURIComponent(typeof v === 'string' ? v : '')
  const reads: Partial<Record<NativeOperation, string>> = {
    resources: '/experimental/resource',
    references: '/api/reference',
    config: '/config',
    gitStatus: '/vcs/status',
    workspaceAdapters: '/experimental/workspace/adapter',
    permissionSaved: '/api/permission/saved',
    organizations: '/experimental/console/orgs',
    commands: '/command',
    agents: '/agent',
    skills: '/skill',
    models: '/provider',
    tools: '/experimental/tool/ids',
    mcp: '/mcp',
    status: '/session/status',
    context: '/api/session/' + segment(sid) + '/context',
    todos: s + '/todo',
    changes: s + '/diff',
    sessions: '/session',
    children: s + '/children',
    history: s + '/message',
    session: s,
    permissions: '/permission',
    lsp: '/lsp',
    formatters: '/formatter',
    terminals: '/pty',
    shells: '/pty/shells',
    providers: '/provider',
    providerAuth: '/provider/auth',
    worktrees: '/experimental/worktree',
    workspaces: '/experimental/workspace',
    workspaceStatus: '/experimental/workspace/status',
  }
  if (reads[request.operation])
    return get(
      reads[request.operation]!,
      ['config', 'models', 'providers', 'mcp', 'providerAuth', 'organizations'].includes(request.operation),
    )
  switch (request.operation) {
    case 'gitDiff':
      return get('/vcs/diff?mode=' + (i.mode === 'branch' ? 'branch' : 'git'))
    case 'configUpdate':
      return { method: 'PATCH', path: '/config', body: i, redact: true }
    case 'gitApply':
      return post('/vcs/apply', i)
    case 'background':
      return post('/experimental/session/' + segment(sid) + '/background', i)
    case 'mcpCallback':
      return post('/mcp/' + segment(i.name) + '/auth/callback', { code: i.code })
    case 'mcpAuthenticate':
      return post('/mcp/' + segment(i.name) + '/auth/authenticate')
    case 'permissionRemove':
      return del('/api/permission/saved/' + segment(i.id))
    case 'organizationSwitch':
      return post('/experimental/console/switch', i)
    case 'files':
      return get('/file?path=' + query(i.path))
    case 'file':
      return get('/file/content?path=' + query(i.path))
    case 'find':
      return get('/find?pattern=' + query(i.pattern))
    case 'symbols':
      return get('/find/symbol?query=' + query(i.query))
    case 'compact':
      return post(s + '/summarize', { ...(selection.model ?? defaults), auto: false })
    case 'command':
      return post(s + '/command', {
        command: i.command,
        arguments: i.arguments ?? '',
        ...selection,
        ...(selection.model
          ? { model: selection.model.providerID + '/' + selection.model.modelID }
          : { model: defaults.providerID + '/' + defaults.modelID }),
      })
    case 'shell':
      return post(s + '/shell', {
        command: i.command,
        agent: selection.agent ?? 'build',
        model: selection.model ?? defaults,
      })
    case 'fork':
      return post(s + '/fork', i.messageID ? { messageID: i.messageID } : {})
    case 'undo':
      return post(s + '/revert', { messageID: i.messageID })
    case 'redo':
      return post(s + '/unrevert')
    case 'rename':
      return { method: 'PATCH', path: s, body: { title: i.title } }
    case 'archive':
      return { method: 'PATCH', path: s, body: { time: { archived: Date.now() } } }
    case 'share':
      return post(s + '/share')
    case 'unshare':
      return del(s + '/share')
    case 'mcpAdd':
      return { ...post('/mcp', { name: i.name, config: i.config }), redact: true }
    case 'mcpConnect':
      return post('/mcp/' + segment(i.name) + '/connect')
    case 'mcpDisconnect':
      return post('/mcp/' + segment(i.name) + '/disconnect')
    case 'mcpAuth':
      return post('/mcp/' + segment(i.name) + '/auth')
    case 'mcpAuthRemove':
      return del('/mcp/' + segment(i.name) + '/auth')
    case 'terminalCreate':
      return post('/pty', {
        ...(i.command ? { command: i.command } : {}),
        ...(i.args ? { args: i.args } : {}),
        title: 'HumanStudy terminal',
      })
    case 'terminalResize':
      return { method: 'PUT', path: '/pty/' + segment(i.id), body: { size: { rows: i.rows, cols: i.cols } } }
    case 'terminalRemove':
      return del('/pty/' + segment(i.id))
    case 'terminalConnect':
      return post('/pty/' + segment(i.id) + '/connect-token')
    case 'providerConnect':
      return post('/provider/' + segment(i.id) + '/oauth/authorize', { method: i.method, inputs: i.inputs })
    case 'providerCallback':
      return post('/provider/' + segment(i.id) + '/oauth/callback', { method: i.method, code: i.code })
    case 'providerKey':
      return { method: 'PUT', path: '/auth/' + segment(i.id), body: { type: 'api', key: i.key } }
    case 'providerRemove':
      return del('/auth/' + segment(i.id))
    case 'worktreeCreate':
      return post('/experimental/worktree', i)
    case 'worktreeRemove':
      return { method: 'DELETE', path: '/experimental/worktree', body: i }
    case 'worktreeReset':
      return post('/experimental/worktree/reset', i)
    case 'gitInit':
      return post('/project/git/init')
    case 'workspaceCreate':
      return post('/experimental/workspace', i)
    case 'workspaceRemove':
      return del('/experimental/workspace/' + segment(i.id))
    case 'workspaceSync':
      return post('/experimental/workspace/sync-list', i)
    default:
      throw Error('Unsupported OpenCode operation: ' + request.operation)
  }
}
