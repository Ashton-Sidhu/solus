/** Order writes to one provider task. A failed write must not block the next command. */
const pending = new Map<string, Promise<void>>()
export async function serializeTaskWrite<Result>(
  taskId: string,
  command: () => Promise<Result>
): Promise<Result> {
  const before = pending.get(taskId) ?? Promise.resolve()
  const result = before.catch(() => {}).then(command)
  const settled = result.then(
    () => {},
    () => {}
  )
  pending.set(taskId, settled)
  try {
    return await result
  } finally {
    if (pending.get(taskId) === settled) pending.delete(taskId)
  }
}
