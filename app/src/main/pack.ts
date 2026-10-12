// The social-science pack (../pack) bundled into the main process as raw strings, so it ships
// inside the built app without extraResources. Copied into each new project:
//   AGENTS.md                      -> <project>/AGENTS.md   (opencode reads it from the cwd)
//   schema/*                       -> <project>/schema/*    (skills cite schema/human-program.schema.json)
//   skills/<name>/**               -> <project>/.opencode/skills/<name>/**  (opencode skill discovery)
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const PREFIX = '../../../pack/'
const files = import.meta.glob(
  ['../../../pack/AGENTS.md', '../../../pack/schema/**/*', '../../../pack/skills/**/*'],
  { query: '?raw', import: 'default', eager: true }
) as Record<string, string>

function target(rel: string): string | null {
  if (rel === 'AGENTS.md') return 'AGENTS.md'
  if (rel.startsWith('schema/')) return rel
  if (rel.startsWith('skills/')) return join('.opencode', rel)
  return null
}

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

export const packFileCount = (): number => Object.keys(files).length
