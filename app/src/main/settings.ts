import { app, nativeTheme } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Settings } from '../preload/types'

const file = (): string => join(app.getPath('userData'), 'settings.json')

export function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

/** Lives under Documents with a distinct name: on a case-insensitive disk ~/HumanStudy can be an
 * existing folder (for example a research workspace called ~/humanstudy). */
export function defaultProjectsRoot(): string {
  return join(homedir(), 'Documents', 'HumanStudy Projects')
}
const RETIRED_ROOTS = [join(homedir(), 'HumanStudy')]

function defaults(): Settings {
  return {
    theme: 'system',
    busyEnter: 'queue',
    permission: 'ask',
    model: 'anthropic/claude-sonnet-5.5',
    projectsRoot: defaultProjectsRoot(),
    notifications: true,
  }
}

function sanitize(raw: Partial<Settings>, base: Settings): Settings {
  const s = { ...base }
  if (raw.theme === 'light' || raw.theme === 'dark' || raw.theme === 'system') s.theme = raw.theme
  if (raw.busyEnter === 'queue' || raw.busyEnter === 'interrupt') s.busyEnter = raw.busyEnter
  if (raw.permission === 'ask' || raw.permission === 'project') s.permission = raw.permission
  if (typeof raw.notifications === 'boolean') s.notifications = raw.notifications
  if (typeof raw.model === 'string' && raw.model.trim()) s.model = raw.model.trim()
  if (typeof raw.projectsRoot === 'string' && raw.projectsRoot.trim()) {
    const root = resolve(expandHome(raw.projectsRoot.trim()))
    // The first default collided with other folders; never keep it.
    if (!RETIRED_ROOTS.some((r) => r.toLowerCase() === root.toLowerCase())) s.projectsRoot = root
  }
  return s
}

let current: Settings | null = null

export function getSettings(): Settings {
  if (current) return current
  let raw: Partial<Settings> = {}
  try {
    raw = JSON.parse(readFileSync(file(), 'utf8')) as Partial<Settings>
  } catch {
    /* first run or unreadable: defaults */
  }
  current = sanitize(raw, defaults())
  return current
}

export function setSettings(patch: Partial<Settings>): Settings {
  const next = sanitize(patch ?? {}, getSettings())
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(file(), JSON.stringify(next, null, 2))
  current = next
  applySettings()
  return next
}

/** Side effects of settings: theme, projects root folder, kernel model env. */
export function applySettings(): void {
  const s = getSettings()
  nativeTheme.themeSource = s.theme
  process.env.HUMANSTUDY_MODEL = s.model
  process.env.HUMANSTUDY_PERMISSION = s.permission
  ensureProjectsRoot()
}

export function ensureProjectsRoot(): string {
  const root = getSettings().projectsRoot
  if (!existsSync(root)) mkdirSync(root, { recursive: true })
  return root
}
