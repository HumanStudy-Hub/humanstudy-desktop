// Compatibility adapter for existing semantic UI instrumentation. No raw input/pointer samples.
import { isProhibitedEventType, type ResearchEvent } from './research-contract'
export function researchInteraction(type: string, opts: { target?: string; durationMs?: number; metadata?: Record<string, unknown> } = {}): Partial<ResearchEvent> & Pick<ResearchEvent, 'event_type'> | null {
  if (isProhibitedEventType(type) || /^(conversation|kernel|agent|replay|consent)\.|^composer\.|^project\.(program_version|file_written)$/.test(type) || type === 'composer.typing_start') return null
  const metadata = { operation: type, ...opts.metadata }, target = opts.target || type
  const duration = typeof opts.durationMs === 'number' ? Math.max(0, Math.min(86400000, Math.round(opts.durationMs))) : undefined
  if (type === 'source.annotated' || type === 'source.annotation_removed') return { event_type: 'annotation.commit', view: 'paper',
    metadata: { ...metadata, annotation_id: opts.metadata?.annotation_id ?? 'not-reported', op: type === 'source.annotated' ? 'add' : 'remove',
      anchor: opts.metadata?.anchor ?? opts.metadata?.pages ?? null } }
  if (type === 'selection.change' || type === 'source.select') return { event_type: 'selection.commit', view: type === 'source.select' ? 'paper' : 'study', metadata: { ...metadata, kind: type } }
  if (/resized|layout|pane\./.test(type)) return { event_type: 'layout.commit', target, metadata: { ...metadata, state: opts.metadata ?? {} } }
  if (type === 'ui.scroll') return { event_type: 'scroll.settle', view: 'workspace', metadata: { ...metadata,
    position: opts.metadata?.endDepth ?? 0, direction: opts.metadata?.direction ?? 'unknown', distance: opts.metadata?.distance ?? 0 } }
  if (type === 'ui.foreground') return { event_type: 'app.foreground', duration_ms: duration ?? 0, metadata }
  if (type === 'app.session_start' || type === 'app.session_end') return null // collector owns lifecycle
  if (duration !== undefined && /tab.switch|thread.switch|source.page|view.dwell/.test(type)) return { event_type: 'view.dwell', target, duration_ms: duration, metadata }
  return { event_type: 'action.invoke', target, view: 'workspace', metadata: { ...metadata,
    via: type === 'shortcut' ? 'shortcut' : type === 'menu.command' ? 'menu' : opts.metadata?.via ?? 'system' } }
}
