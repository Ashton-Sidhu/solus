export function taskTabTarget(
  taskTabIds: string[],
  attentionTarget: string | null,
  lastActiveBranchTabId: string | null,
  runningTabId: string | null = null,
): string | undefined {
  if (attentionTarget) return attentionTarget
  if (lastActiveBranchTabId && taskTabIds.includes(lastActiveBranchTabId)) {
    return lastActiveBranchTabId
  }
  // Nothing is asking for the user and they have not been in this branch yet.
  // A session working right now is more relevant than the oldest tab, so prefer
  // it over the plain first-tab fallback (e.g. one done + one running lands on
  // the running one, not the done one just because it opened first).
  if (runningTabId && taskTabIds.includes(runningTabId)) return runningTabId
  return taskTabIds[0]
}
