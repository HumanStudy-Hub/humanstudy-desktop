const ACTIVE_PROJECT = 'hs.activeProject'

export function browserProject(): string | null {
  try {
    return sessionStorage.getItem(ACTIVE_PROJECT)
  } catch {
    return null
  }
}

export function rememberBrowserProject(dir: string | null): void {
  try {
    if (dir) sessionStorage.setItem(ACTIVE_PROJECT, dir)
    else sessionStorage.removeItem(ACTIVE_PROJECT)
  } catch {
    // The workspace is usable when storage is unavailable.
  }
}
