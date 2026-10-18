import { useCallback, useEffect, useRef, useState } from 'react'
import type { Session } from '../useSession'
import type { NativeCatalog, NativeRequest } from '../../shared/native'
import { parseSlash, UI_COMMANDS, type UiCommand } from '../native-commands'
import { copyText } from './Markdown'
import { NativePanel, type NativeView } from './NativePanel'
export function useNativeControls(session: Session, onSettings: () => void) {
  const current = useRef(session)
  current.current = session
  const [catalog, setCatalog] = useState<NativeCatalog | null>(null),
    [view, setView] = useState<NativeView | null>(null),
    [notice, setNotice] = useState(''),
    [timestamps, setTimestamps] = useState(false)
  const run = useCallback((r: NativeRequest) => current.current.native(r), [])
  const reload = useCallback(() => {
    const sid = current.current.id
    void run({ operation: 'catalog' })
      .then((v) => {
        if (current.current.id === sid) setCatalog(v as NativeCatalog)
      })
      .catch(() => {
        if (current.current.id === sid) setCatalog(null)
      })
  }, [run])
  useEffect(() => {
    setView(null)
    setNotice('')
    setCatalog(null)
    if (session.id) reload()
  }, [session.id, reload])
  const execute = async (text: string) => {
    const parsed = parseSlash(text)
    if (!parsed) return false
    setNotice('')
    const alias: Record<string, string> = {
      summarize: 'compact',
      model: 'models',
      agent: 'agents',
      todo: 'tasks',
      diff: 'changes',
      resume: 'sessions',
      open: 'files',
    }
    const name = alias[parsed.name] ?? parsed.name,
      args = parsed.args
    const item = UI_COMMANDS.find((c) => c.name === name)
    try {
      if (name === 'help') {
        setView({ operation: 'commands', title: 'OpenCode commands and skills' })
        return true
      }
      if (name === 'stop') {
        current.current.abort()
        return true
      }
      if (name === 'new') {
        current.current.newThread()
        return true
      }
      if (name === 'settings' || name === 'theme') {
        onSettings()
        return true
      }
      if (name === 'timestamps') {
        setTimestamps((v) => !v)
        return true
      }
      if (name === 'copy') {
        await copyText(
          current.current.messages
            .map(
              (m) =>
                m.role +
                '\n' +
                m.parts
                  .map((p) => (p.kind === 'text' || p.kind === 'reasoning' ? p.text : JSON.stringify(p, null, 2)))
                  .join('\n'),
            )
            .join('\n\n'),
        )
        setNotice('Conversation copied.')
        return true
      }
      if (name === 'export') {
        const path = await window.humanstudy.kernel.export(current.current.id!)
        if (path) setNotice('Conversation exported.')
        return true
      }
      if (name === 'agents' && args) {
        await run({ operation: 'select', input: { agent: args.trim() } })
        reload()
        return true
      }
      if (name === 'models' && args) {
        const split = args.indexOf('/')
        if (split < 1) throw Error('Use /models provider/model.')
        await run({
          operation: 'select',
          input: { model: { providerID: args.slice(0, split), modelID: args.slice(split + 1) } },
        })
        reload()
        return true
      }
      if (name === 'variant') {
        await run({ operation: 'select', input: { variant: args.trim() } })
        reload()
        return true
      }
      if (name === 'parent') {
        const info = (await run({ operation: 'session' })) as { parentID?: string }
        if (!info.parentID) throw Error('This conversation has no parent.')
        await run({ operation: 'open', input: { id: info.parentID } })
        return true
      }
      if (name === 'children') {
        setView({ operation: 'children', title: 'Conversation branches' })
        return true
      }
      if (item?.operation) {
        const operation = item.operation
        if (operation === 'rename' && args) {
          await run({ operation, input: { title: args } })
          return true
        }
        if (operation === 'shell' && args) {
          await run({ operation, input: { command: args } })
          return true
        }
        if (['compact', 'fork', 'undo', 'redo', 'archive', 'unshare', 'background'].includes(operation)) {
          await run({ operation })
          if (operation === 'archive') current.current.newThread(true)
          return true
        }
        if (['rename', 'shell'].includes(operation)) {
          setView({ operation: operation === 'rename' ? 'session' : 'status', action: operation, title: item.label })
          return true
        }
        setView({
          operation,
          input: name === 'find' ? { pattern: args } : name === 'symbols' ? { query: args } : undefined,
          title: item.label,
          preview: operation === 'share',
        })
        return true
      }
      const command = catalog?.commands.find((c) => c.name.toLowerCase() === parsed.name.toLowerCase())
      if (command) {
        await run({ operation: 'command', input: { command: command.name, arguments: args } })
        return true
      }
      throw Error('Unknown command. Type / to see commands supplied by this OpenCode kernel.')
    } catch (e) {
      setNotice(String(e).replace(/^Error: /, ''))
      return true
    }
  }
  const items: UiCommand[] = [
    ...UI_COMMANDS,
    { name: 'stop', label: 'Stop', description: 'Stop the current response.', client: true },
    { name: 'settings', label: 'Settings', description: 'Open application settings.', client: true },
    { name: 'parent', label: 'Parent conversation', description: 'Return to the parent conversation.', client: true },
    { name: 'children', label: 'Conversation branches', description: 'Inspect child sessions.', client: true },
    {
      name: 'variant',
      label: 'Model variant',
      description: 'Choose a reasoning variant with /variant name.',
      client: true,
    },
    ...(catalog?.commands ?? [])
      .filter((c) => !UI_COMMANDS.some((x) => x.name === c.name))
      .map((c) => ({ name: c.name, label: c.name, description: c.description ?? 'OpenCode project command' })),
  ]
  return {
    items,
    execute,
    notice,
    timestamps,
    selection: catalog?.selection,
    panel:
      view && session.id ? (
        <NativePanel
          key={session.id + ':' + view.operation + ':' + view.action + ':' + view.preview}
          view={view}
          sessionId={session.id}
          run={run}
          onClose={() => {
            setView(null)
            reload()
          }}
          onSelected={reload}
        />
      ) : null,
  }
}
