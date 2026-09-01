export async function runBounded<T>(tasks: (() => Promise<T>)[], concurrency: number, onResult?: (result: T, index: number) => void): Promise<T[]> {
  const results: T[] = new Array(tasks.length)
  let idx = 0

  async function worker() {
    while (idx < tasks.length) {
      const i = idx++
      results[i] = await tasks[i]()
      onResult?.(results[i], i)
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()))
  return results
}
