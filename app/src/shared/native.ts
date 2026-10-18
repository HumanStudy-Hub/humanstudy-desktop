/** User-facing OpenCode operations. Server credentials and arbitrary URLs never cross IPC. */
export type NativeOperation =
  | 'resources'
  | 'references'
  | 'config'
  | 'configUpdate'
  | 'gitStatus'
  | 'gitDiff'
  | 'gitApply'
  | 'workspaceAdapters'
  | 'background'
  | 'mcpCallback'
  | 'mcpAuthenticate'
  | 'permissionSaved'
  | 'permissionRemove'
  | 'organizations'
  | 'organizationSwitch'
  | 'open'
  | 'catalog'
  | 'commands'
  | 'agents'
  | 'skills'
  | 'models'
  | 'tools'
  | 'mcp'
  | 'status'
  | 'context'
  | 'todos'
  | 'changes'
  | 'files'
  | 'file'
  | 'find'
  | 'symbols'
  | 'sessions'
  | 'children'
  | 'history'
  | 'session'
  | 'permissions'
  | 'lsp'
  | 'formatters'
  | 'terminals'
  | 'shells'
  | 'compact'
  | 'command'
  | 'shell'
  | 'fork'
  | 'undo'
  | 'redo'
  | 'rename'
  | 'archive'
  | 'share'
  | 'unshare'
  | 'select'
  | 'mcpAdd'
  | 'mcpConnect'
  | 'mcpDisconnect'
  | 'mcpAuth'
  | 'mcpAuthRemove'
  | 'terminalCreate'
  | 'terminalResize'
  | 'terminalRemove'
  | 'terminalConnect'
  | 'providers'
  | 'providerAuth'
  | 'providerConnect'
  | 'providerCallback'
  | 'providerKey'
  | 'providerRemove'
  | 'worktrees'
  | 'worktreeCreate'
  | 'worktreeRemove'
  | 'worktreeReset'
  | 'gitInit'
  | 'workspaces'
  | 'workspaceCreate'
  | 'workspaceRemove'
  | 'workspaceSync'
  | 'workspaceStatus'
export interface NativeRequest {
  operation: NativeOperation
  input?: Record<string, unknown>
}
export interface NativeSelection {
  agent?: string
  variant?: string
  model?: { providerID: string; modelID: string }
}
export interface NativeMenuItem {
  name: string
  description?: string
  source?: string
  agent?: string
}
export interface NativeCatalog {
  commands: NativeMenuItem[]
  agents: NativeMenuItem[]
  skills: NativeMenuItem[]
  selection: NativeSelection
}
export const NATIVE_MUTATIONS = new Set<NativeOperation>([
  'configUpdate',
  'gitApply',
  'background',
  'mcpCallback',
  'mcpAuthenticate',
  'permissionRemove',
  'organizationSwitch',
  'compact',
  'command',
  'shell',
  'fork',
  'undo',
  'redo',
  'rename',
  'archive',
  'share',
  'unshare',
  'select',
  'mcpAdd',
  'mcpConnect',
  'mcpDisconnect',
  'mcpAuth',
  'mcpAuthRemove',
  'terminalCreate',
  'terminalResize',
  'terminalRemove',
  'terminalConnect',
  'providerConnect',
  'providerCallback',
  'providerKey',
  'providerRemove',
  'worktreeCreate',
  'worktreeRemove',
  'worktreeReset',
  'gitInit',
  'workspaceCreate',
  'workspaceRemove',
  'workspaceSync',
])
export const NATIVE_TURNS = new Set<NativeOperation>(['compact', 'command', 'shell'])

export const NATIVE_SESSION_MUTATIONS = new Set([...NATIVE_MUTATIONS].filter((op) => !op.startsWith('terminal')))
