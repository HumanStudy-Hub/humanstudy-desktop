// The folder name of a project, from a title the researcher typed or a study file carried. Electron-free so the
// study transfer (study-transfer.ts) and its tests share it with projects.ts.
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
