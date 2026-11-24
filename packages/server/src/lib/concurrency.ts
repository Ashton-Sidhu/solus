export async function runBounded<T>(tasks: (() => Promise<T>)[], concurrency: number, onResult?: (result: T, index: number) => void): Promise<T[]> {
  const results: T[] = []
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

const pendingByKey = new Map<string, Promise<void>>()

/**
 * Run the commands of one key one at a time, in the order of the calls. A
 * command that fails does not stop the next one.
 */
export async function runOneAtATime<T>(key: string, command: () => Promise<T>): Promise<T> {
  const before = pendingByKey.get(key) ?? Promise.resolve()
  const result = before.then(command)
  const settled = result.then(() => {}, () => {})
  pendingByKey.set(key, settled)
  try {
    return await result
  } finally {
    if (pendingByKey.get(key) === settled) pendingByKey.delete(key)
  }
}
