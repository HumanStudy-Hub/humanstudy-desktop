// Is this project folder someone else's study revision? The app shows the run notice for these
// (package-readiness.ts communityRunNotice). A fork made in the app has .humanstudy/community.json;
// a revision opened with "Open folder…" carries the metadata below instead.
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** Fields the community library writes into sources/study.json (community.ts forkCommunityStudy). */
const REVISION_FIELDS = ['baseRevision', 'currentRevision', 'commit', 'repoUrl', 'forkedAt']

const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false)

/** True for a downloaded community revision, an unzipped contribution or an exported agent folder.
 *  Conservative: unreadable or malformed metadata counts as a revision. */
export async function looksLikeRevision(projectDir: string): Promise<boolean> {
  if (await exists(join(projectDir, 'CONTRIBUTION.json'))) return true
  if (await exists(join(projectDir, 'scripts/study_core.py'))) return true
  let text: string
  try {
    text = await readFile(join(projectDir, 'sources/study.json'), 'utf8')
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT'
  }
  try {
    const meta = JSON.parse(text)
    return !meta || typeof meta !== 'object' || REVISION_FIELDS.some((k) => k in meta)
  } catch {
    return true
  }
}
