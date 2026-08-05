export function taskTabTarget(
  taskTabIds: string[],
  attentionTarget: string | null,
  lastActiveBranchTabId: string | null,
): string | undefined {
  if (attentionTarget) return attentionTarget
  if (lastActiveBranchTabId && taskTabIds.includes(lastActiveBranchTabId)) {
    return lastActiveBranchTabId
  }
  return taskTabIds[0]
}
