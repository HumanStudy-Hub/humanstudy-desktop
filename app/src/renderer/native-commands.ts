import type { NativeOperation } from '../shared/native'
export interface UiCommand {
  name: string
  label: string
  description: string
  operation?: NativeOperation
  client?: boolean
}
export const UI_COMMANDS: UiCommand[] = [
  {
    name: 'resources',
    label: 'Tool resources',
    description: 'Inspect resources supplied by connected tools.',
    operation: 'resources',
  },
  {
    name: 'references',
    label: 'Context references',
    description: 'Inspect references known to the native kernel.',
    operation: 'references',
  },
  {
    name: 'config',
    label: 'OpenCode project settings',
    description: 'Inspect settings and apply an explicit JSON patch.',
    operation: 'config',
  },
  { name: 'git', label: 'Git status', description: 'Inspect repository status and changes.', operation: 'gitStatus' },
  {
    name: 'background',
    label: 'Background session',
    description: 'Use native background-session support.',
    operation: 'background',
  },
  {
    name: 'workspaces-status',
    label: 'Workspace status',
    description: 'Inspect workspace synchronization.',
    operation: 'workspaceStatus',
  },
  {
    name: 'workspace-adapters',
    label: 'Workspace adapters',
    description: 'Inspect adapters available in this kernel.',
    operation: 'workspaceAdapters',
  },
  {
    name: 'saved-permissions',
    label: 'Saved permissions',
    description: 'Inspect and remove remembered permission grants.',
    operation: 'permissionSaved',
  },
  {
    name: 'organizations',
    label: 'OpenCode organizations',
    description: 'Inspect organizations available to native connected services.',
    operation: 'organizations',
  },
  {
    name: 'compact',
    label: 'Compact context',
    description: 'Summarize the model context; retain full saved history.',
    operation: 'compact',
  },
  { name: 'new', label: 'New conversation', description: 'Start a new conversation in this project.', client: true },
  {
    name: 'sessions',
    label: 'Conversations',
    description: 'Open native sessions and archived conversations.',
    operation: 'sessions',
  },
  {
    name: 'fork',
    label: 'Branch conversation',
    description: 'Continue from a copy of the current conversation.',
    operation: 'fork',
  },
  {
    name: 'undo',
    label: 'Undo last turn',
    description: 'Use OpenCode to revert the last turn and tracked file changes.',
    operation: 'undo',
  },
  {
    name: 'redo',
    label: 'Restore undone turns',
    description: 'Restore the native conversation and tracked changes.',
    operation: 'redo',
  },
  {
    name: 'timeline',
    label: 'Conversation timeline',
    description: 'Choose an earlier turn to branch or undo from.',
    operation: 'history',
  },
  { name: 'rename', label: 'Rename conversation', description: 'Rename this conversation.', operation: 'rename' },
  {
    name: 'archive',
    label: 'Archive conversation',
    description: 'Archive this conversation without deleting it.',
    operation: 'archive',
  },
  {
    name: 'export',
    label: 'Export conversation',
    description: 'Save the complete conversation as JSON or Markdown.',
    client: true,
  },
  { name: 'copy', label: 'Copy conversation', description: 'Copy the full visible conversation.', client: true },
  {
    name: 'share',
    label: 'Share conversation',
    description: 'Review the conversation before creating a public link.',
    operation: 'share',
  },
  {
    name: 'unshare',
    label: 'Remove shared link',
    description: 'Revoke the native shared conversation link.',
    operation: 'unshare',
  },
  { name: 'status', label: 'Agent status', description: 'Inspect running sessions.', operation: 'status' },
  {
    name: 'context',
    label: 'Model context',
    description: 'Inspect the context currently available to the agent.',
    operation: 'context',
  },
  { name: 'tasks', label: 'Task list', description: 'See the agent’s native task list.', operation: 'todos' },
  {
    name: 'changes',
    label: 'File changes',
    description: 'Review the agent’s changes in this conversation.',
    operation: 'changes',
  },
  {
    name: 'agents',
    label: 'Choose agent',
    description: 'Use an agent supplied by OpenCode or this project.',
    operation: 'agents',
  },
  {
    name: 'models',
    label: 'Choose model / variant',
    description: 'Choose from connected native providers.',
    operation: 'models',
  },
  { name: 'skills', label: 'Skills', description: 'Inspect skills discovered from the project.', operation: 'skills' },
  {
    name: 'commands',
    label: 'Project commands',
    description: 'Run OpenCode commands and skill commands.',
    operation: 'commands',
  },
  { name: 'tools', label: 'Available tools', description: 'Inspect native tool IDs.', operation: 'tools' },
  {
    name: 'mcp',
    label: 'Connected tools · MCP',
    description: 'Add, authenticate, connect or disconnect MCP servers.',
    operation: 'mcp',
  },
  {
    name: 'connect',
    label: 'Providers',
    description: 'Connect model providers using their native authentication.',
    operation: 'providers',
  },
  {
    name: 'terminal',
    label: 'Terminal',
    description: 'Open a native interactive project terminal.',
    operation: 'terminals',
  },
  {
    name: 'shell',
    label: 'Run a command',
    description: 'Run an explicitly entered shell command through OpenCode.',
    operation: 'shell',
  },
  { name: 'files', label: 'Project files', description: 'Browse native file contents and status.', operation: 'files' },
  { name: 'find', label: 'Search project', description: 'Search project file contents.', operation: 'find' },
  { name: 'symbols', label: 'Find symbols', description: 'Search indexed project symbols.', operation: 'symbols' },
  {
    name: 'permissions',
    label: 'Permission requests',
    description: 'Inspect pending native permission requests.',
    operation: 'permissions',
  },
  { name: 'lsp', label: 'Language tools', description: 'Inspect native language-service status.', operation: 'lsp' },
  { name: 'formatters', label: 'Formatters', description: 'Inspect native formatter status.', operation: 'formatters' },
  {
    name: 'worktrees',
    label: 'Git worktrees',
    description: 'Manage OpenCode worktrees for Git-backed projects.',
    operation: 'worktrees',
  },
  {
    name: 'workspaces',
    label: 'Workspaces',
    description: 'Manage workspace adapters supplied by this kernel.',
    operation: 'workspaces',
  },
  {
    name: 'thinking',
    label: 'Reasoning records',
    description: 'Inspect reasoning exposed by the provider in native history.',
    operation: 'history',
  },
  { name: 'timestamps', label: 'Message times', description: 'Show or hide message timestamps.', client: true },
  { name: 'help', label: 'Commands', description: 'Show the available commands.', client: true },
]
export function parseSlash(text: string): { name: string; args: string } | null {
  const m = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text.trim())
  return m ? { name: m[1].toLowerCase(), args: m[2] ?? '' } : null
}
