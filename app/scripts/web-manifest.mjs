import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')

// The same source files included by pack.ts's raw import glob. Hash paths as well as bytes.
export function packHash(root) {
  const entries = []
  function visit(relative = '') {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.name === '__pycache__' || entry.name.endsWith('.pyc') || entry.name.startsWith('.')) continue
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile() && (['AGENTS.md', 'PROJECT_FORMAT.md', 'runtime/lib/hs_original_text.py'].includes(path)
        || /^(schema|skills|runtime\/hsenv)\//.test(path) || /^artifact-kit\/[^/]+$/.test(path))) {
        entries.push([path, sha(readFileSync(join(root, path)))])
      }
    }
  }
  visit()
  entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  return sha(JSON.stringify(entries))
}

export function webManifest(repo, version) {
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
  const gitsha = git('rev-parse', 'HEAD')
  const dirty = Boolean(git('status', '--porcelain', '--untracked-files=normal'))
  const tag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined
  if (tag && (tag !== `v${version}` || dirty)) throw new Error('Release tag must match the package version and a clean source tree')
  return { version, gitsha, packhash: packHash(join(repo, 'pack')), dirty }
}
