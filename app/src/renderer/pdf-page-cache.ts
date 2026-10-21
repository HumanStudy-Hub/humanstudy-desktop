/** Read each requested page once. Opening a paper never indexes all its text. */
export function createPageCache<T>(read: (page: number) => Promise<T>) {
  const pending = new Map<number, Promise<T>>()
  return (page: number): Promise<T> => {
    let result = pending.get(page)
    if (!result) {
      result = new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => read(page))
      pending.set(page, result)
      result.catch(() => pending.delete(page))
    }
    return result
  }
}
