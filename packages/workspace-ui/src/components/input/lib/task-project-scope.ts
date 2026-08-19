export interface TaskProjectScope {
  sourceId: string | undefined
  workingDirectory: string
}

export function shouldResetTaskForProjectChange(
  previous: TaskProjectScope | null,
  next: TaskProjectScope,
): boolean {
  return (
    previous !== null &&
    previous.sourceId === next.sourceId &&
    previous.workingDirectory !== next.workingDirectory
  )
}
