// The social-science pack (../pack) bundled into the main process as raw strings, so it ships
// inside the built app without extraResources. Copied into each new project:
//   AGENTS.md                      -> <project>/AGENTS.md   (opencode reads it from the cwd)
//   PROJECT_FORMAT.md              -> <project>/.opencode/PROJECT_FORMAT.md
//   schema/*                       -> <project>/schema/*    (skills cite schema/human-program.schema.json)
//   skills/<name>/**               -> <project>/.opencode/skills/<name>/**  (opencode skill discovery)
//   artifact-kit/*                 -> <project>/.opencode/artifact-kit/*    (offline HTML kit; inline.py embeds it
//                                     into each artifact, so artifacts stay self-contained)
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import previousHashes from './previous-pack-hashes.json'
import { dirname, join } from 'node:path'

const PREFIX = '../../../pack/'
const files = import.meta.glob(
  ['../../../pack/AGENTS.md', '../../../pack/PROJECT_FORMAT.md', '../../../pack/schema/**/*', '../../../pack/skills/**/*', '../../../pack/artifact-kit/*',
    '!**/__pycache__/**', '!**/*.pyc'],
  { query: '?raw', import: 'default', eager: true }
) as Record<string, string>

function target(rel: string): string | null {
  if (rel === 'AGENTS.md') return 'AGENTS.md'
  if (rel === 'PROJECT_FORMAT.md') return join('.opencode', rel)
  if (rel.startsWith('schema/')) return rel
  if (rel.startsWith('skills/')) return join('.opencode', rel)
  if (rel.startsWith('artifact-kit/')) return join('.opencode', rel)
  return null
}

/** Pack-relative paths of the artifact kit (app-owned: always kept at the shipped version). */
export const kitFiles = (): string[] =>
  Object.keys(files).filter((k) => k.startsWith(PREFIX + 'artifact-kit/')).map((k) => k.slice(PREFIX.length))

export async function installPack(projectDir: string): Promise<void> {
  for (const [key, content] of Object.entries(files)) {
    if (!key.startsWith(PREFIX)) continue
    const dest = target(key.slice(PREFIX.length))
    if (!dest) continue
    const abs = join(projectDir, dest)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, content, 'utf8')
  }
}

/** Pack-relative helper scripts that refreshPack keeps current (see refreshPack). */
const HELPERS = ['skills/build/program_io.py', 'skills/build/program_lock.py', 'skills/build/check_program.py', 'schema/build-coverage.json',
  'skills/build/check_quotes.py', 'skills/build/check_results.py', 'skills/build/check_verbatim.py', 'skills/build/check_validity.py',
  'skills/build/sources.py', 'skills/export/agent_package.py', 'skills/export/agent/study_core.py', 'skills/export/agent/mcp_server.py',
  'skills/export/agent/effects_core.py', 'skills/build/effects.py', 'schema/effects.schema.json',
  'skills/simulate/run_confined.py', 'skills/simulate/simkit.py', 'schema/graph-types.json', 'skills/build/sandbox_run.py', 'skills/build/check_package.py', 'skills/build/check_readiness.py',
  'skills/build/check_materials.py', 'skills/export/community.py', 'skills/build/fetch_source.py', 'skills/build/qsf_flow.py',
  'skills/build/check_replies.py', 'skills/build/recorded_answers.py', 'skills/build/package_files/replies.py',
  'skills/build/estimate_run.py', 'skills/build/paper_tables.py', 'skills/build/check_source_use.py', 'skills/build/contract.py']

export const packFileCount = (): number => Object.keys(files).length

/** Upgrade untouched default prompts in existing projects; never overwrite custom instructions. */
export async function refreshPack(projectDir: string): Promise<void> {
  // New shipped skills become available in existing projects too. Never replace a researcher file.
  for (const [key, content] of Object.entries(files)) {
    if (!key.startsWith(PREFIX)) continue
    const dest = target(key.slice(PREFIX.length))
    if (!dest) continue
    const abs = join(projectDir, dest)
    if (await readFile(abs, 'utf8').then(() => true).catch(() => false)) continue
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, content, 'utf8')
  }
  for (const [rel, hash] of Object.entries(previousHashes)) {
    const dest = target(rel)
    const content = files[PREFIX + rel]
    if (!dest || !content) continue
    const abs = join(projectDir, dest)
    const old = await readFile(abs, 'utf8').catch(() => null)
    if (old === null || (Array.isArray(hash) ? hash : [hash]).includes(createHash('sha256').update(old).digest('hex'))) {
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, content, 'utf8')
    }
  }
  // App-owned helper scripts the skills call: kept at the shipped version, also in projects made before them.
  for (const rel of HELPERS) {
    const abs = join(projectDir, target(rel)!)
    const content = files[PREFIX + rel]
    if (content === undefined || (await readFile(abs, 'utf8').catch(() => null)) === content) continue
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, content, 'utf8')
  }
  // The artifact kit is vendored code, not researcher instructions: install or update it as shipped.
  for (const rel of kitFiles()) {
    const abs = join(projectDir, target(rel)!)
    const content = files[PREFIX + rel]
    const old = await readFile(abs, 'utf8').catch(() => null)
    if (old === content) continue
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, content, 'utf8')
  }
}

/** The checker files the app runs itself (scientific-readiness.ts): the build checks, the schemas and
 *  effects_core.py, as shipped. Never the project's editable .opencode copy, so editing a checker inside a
 *  project cannot change what the app accepts as ready. */
export function trustedCheckFiles(): [string, string][] {
  return Object.entries(files)
    .filter(([key]) => key.startsWith(PREFIX + 'skills/build/') || key.startsWith(PREFIX + 'schema/') || key === PREFIX + 'skills/export/agent/effects_core.py')
    .map(([key, content]) => [key.slice(PREFIX.length), content])
}
