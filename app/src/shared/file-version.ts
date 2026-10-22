// A source file replaced at the same path (paper.pdf A → B) keeps its path and its hsfile:// URL, so
// nothing downstream knew to reload it. Each listed file now carries a version stamp from its stat;
// the viewer loads `url?v=<stamp>` and treats a new stamp as a new document.

/** The stat fields that change when a file is rewritten or replaced. Size and mtime alone can miss a
 * replacement on Windows, where copying a file keeps the source's modified time; the change time and
 * the file id (inode) do not survive a rename-replace or a rewrite. */
export type FileStat = { size: number; mtimeMs: number; ctimeMs: number; ino: number | bigint }

export function fileVersion(st: FileStat): string {
  return [st.size, Math.round(st.mtimeMs), Math.round(st.ctimeMs), String(st.ino)].join('-')
}

/** The file's URL for this version, so a replaced file is fetched again rather than served from cache. */
export function versionedUrl(url: string, version?: string): string {
  if (!version) return url
  return `${url}${url.includes('?') ? '&' : '?'}v=${encodeURIComponent(version)}`
}

/** The same file (path) now on disk in another version: the viewer must reload and say so. */
export function replacedOnDisk(
  shown: { path: string; version?: string } | null | undefined,
  now: { path: string; version?: string } | null | undefined,
): boolean {
  return Boolean(shown && now && shown.path === now.path && shown.version && now.version && shown.version !== now.version)
}
