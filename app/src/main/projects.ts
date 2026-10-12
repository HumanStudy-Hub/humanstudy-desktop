import { shell } from 'electron'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import sampleProgram from '../shared/sample-program.json'
import { installPack } from './pack'
import { ensureProjectsRoot, getSettings } from './settings'
import type { ProjectSummary } from '../preload/types'

/** True when p is strictly inside root (root itself does not count). */
export function isInside(root: string, p: string): boolean {
  const r = resolve(root)
  const q = resolve(p)
  return q.startsWith(r + sep)
}

export function safeName(name: string): string {
  const cleaned = name
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\-\s]+|[.\s]+$/g, '')
    .slice(0, 80)
    .trim()
  return cleaned || 'Untitled study'
}

function uniqueDir(parent: string, name: string, except?: string): string {
  const base = safeName(name)
  let candidate = join(parent, base)
  for (let i = 2; existsSync(candidate) && candidate !== except; i++) candidate = join(parent, `${base} ${i}`)
  return candidate
}

async function mtimeOf(p: string): Promise<number> {
  try {
    return (await stat(p)).mtimeMs
  } catch {
    return 0
  }
}

async function summarize(dir: string): Promise<ProjectSummary> {
  let latest = await mtimeOf(dir)
  try {
    for (const d of await readdir(dir, { withFileTypes: true })) {
      if (d.name === '.DS_Store') continue
      latest = Math.max(latest, await mtimeOf(join(dir, d.name)))
      // Editing a file in place only touches the file, not its folder: look one level down
      // (notes, artifacts, .humanstudy/threads is covered below).
      if (d.isDirectory() && d.name !== 'node_modules' && d.name !== '.git') {
        for (const f of await readdir(join(dir, d.name)).catch(() => [] as string[])) {
          if (f !== '.DS_Store') latest = Math.max(latest, await mtimeOf(join(dir, d.name, f)))
        }
      }
    }
  } catch {
    /* unreadable folder */
  }
  // Chat threads are saved as files under .humanstudy/threads, so the agent working shows up here.
  for (const f of await readdir(join(dir, '.humanstudy', 'threads')).catch(() => [] as string[])) {
    latest = Math.max(latest, await mtimeOf(join(dir, '.humanstudy', 'threads', f)))
  }
  let artifactCount = 0
  try {
    for (const d of await readdir(join(dir, 'artifacts'), { withFileTypes: true })) {
      if (d.name.startsWith('.')) continue
      latest = Math.max(latest, await mtimeOf(join(dir, 'artifacts', d.name)))
      if (d.isFile()) artifactCount++
    }
  } catch {
    /* no artifacts yet */
  }
  let title: string | undefined
  try {
    const t = (JSON.parse(await readFile(join(dir, 'program.json'), 'utf8')) as { source?: { title?: unknown } }).source?.title
    if (typeof t === 'string' && t.trim() && t.trim() !== basename(dir)) title = t.trim()
  } catch {
    /* no program yet */
  }
  return {
    dir,
    name: basename(dir),
    title,
    updatedAt: new Date(latest || Date.now()).toISOString(),
    hasPaper: existsSync(join(dir, 'paper.pdf')),
    hasProgram: existsSync(join(dir, 'program.json')),
    artifactCount,
  }
}

/** Only folders this app created carry the marker, so other folders are never listed, renamed or trashed. */
const MARKER = join('.humanstudy', 'project.json')
export function isProject(dir: string): boolean {
  return existsSync(join(dir, MARKER))
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const root = ensureProjectsRoot()
  const dirs = (await readdir(root, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => join(root, d.name))
    .filter(isProject)
  const out = await Promise.all(dirs.map(summarize))
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function createProject(input: { name: string; pdfPath?: string; sample?: boolean }): Promise<string> {
  const root = ensureProjectsRoot()
  let name = (input?.name ?? '').trim()
  const sample = Boolean(input?.sample)
  if (!name && sample) name = String((sampleProgram as { title?: unknown }).title ?? 'Sample study')
  if (!name && input?.pdfPath) name = basename(input.pdfPath).replace(/\.pdf$/i, '')
  const dir = uniqueDir(root, name)
  await mkdir(dir, { recursive: true })
  await mkdir(join(dir, 'artifacts'), { recursive: true })
  await mkdir(join(dir, 'exports'), { recursive: true })
  await mkdir(join(dir, '.humanstudy'), { recursive: true })
  await writeFile(join(dir, MARKER), JSON.stringify({ format: 1, createdAt: new Date().toISOString() }, null, 2) + '\n')
  if (input?.pdfPath) await copyFile(resolve(input.pdfPath), join(dir, 'paper.pdf'))
  if (sample) await writeFile(join(dir, 'program.json'), JSON.stringify(sampleProgram, null, 2) + '\n')
  await installPack(dir)
  return dir
}

export async function renameProject(dir: string, name: string): Promise<string> {
  const root = getSettings().projectsRoot
  const from = resolve(dir)
  if (!isInside(root, from) || !isProject(from)) throw new Error('can only rename HumanStudy projects inside the projects folder')
  if (safeName(name) === basename(from)) return from
  const to = uniqueDir(dirname(from), name, from)
  if (to === from) return from
  await rename(from, to)
  return to
}

export async function trashProject(dir: string): Promise<void> {
  const root = getSettings().projectsRoot
  const p = resolve(dir)
  if (!isInside(root, p) || !isProject(p) || p === resolve(root)) throw new Error('refusing to trash a folder that is not a HumanStudy project')
  await shell.trashItem(p)
}
