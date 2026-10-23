/** How a file path is shown in the UI: relative to the project root inside it, `~`-abbreviated absolute
 *  outside. Some diff headers lose the leading slash ("Users/me/x"); it is put back when the path
 *  only makes sense as absolute. Pure string work, so it runs in the renderer and in tests. */
export function displayPath(path: string, projectDir: string | null | undefined, home?: string | null): string {
  let p = path.replace(/\\/g, '/').trim().replace(/(.)\/+$/, '$1')
  if (!p) return p
  const root = (projectDir ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  const h = (home ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  // Windows drive paths compare without case: tools report C:/Users/me and c:/users/me for one folder.
  const fold = (x: string) => (/^[A-Za-z]:\//.test(x) ? x.toLowerCase() : x)
  const within = (base: string, x: string) => Boolean(base) && (fold(x) === fold(base) || fold(x).startsWith(fold(base) + '/'))
  if (!p.startsWith('/') && !/^[A-Za-z]:\//.test(p)) {
    const abs = '/' + p
    if (within(root, abs) || within(h, abs)) p = abs
    else return p // already relative
  }
  if (within(root, p)) return p === root ? '.' : p.slice(root.length + 1)
  if (within(h, p)) return '~' + p.slice(h.length)
  return p
}
