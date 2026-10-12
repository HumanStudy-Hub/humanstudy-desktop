/** electron-updater fails with this when the GitHub repo has no published release yet: not a problem to show. */
export function isNoReleaseError(message: string): boolean {
  return /no published versions|latest\.yml.*(404|not found)|cannot find latest.*(yml|release)/i.test(message)
}

/** A short line for the About page: the first line of the error, without stack or HTML. */
export function shortError(message: string): string {
  const line = message.split('\n')[0].replace(/<[^>]*>/g, '').trim()
  return line.length > 140 ? line.slice(0, 137) + '…' : line
}
