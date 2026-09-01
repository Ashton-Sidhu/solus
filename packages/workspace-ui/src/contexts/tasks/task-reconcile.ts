import type { TaskMirroredTicket, TaskPr, TaskSidebarPrLink } from '@solus/contracts/task-types'

// Whether a re-read carries the same value a task already holds.
//
// Every snapshot and detail read answers with a whole task, and most of those
// reads change nothing. A `$state` write of an equal primitive notifies nobody,
// so only a task's composite fields need comparing: those arrive with a fresh
// identity each time, and writing one back would invalidate every derived that
// reads it — including the sidebar's pull request discovery inputs, whose effect
// issued the read in the first place.

export function sameStrings(
  current: readonly string[] | undefined,
  next: readonly string[] | undefined,
): boolean {
  if (current === next) return true
  if (!current || !next || current.length !== next.length) return false
  return current.every((value, index) => value === next[index])
}

export function samePr(current: TaskPr | undefined, next: TaskPr | undefined): boolean {
  if (current === next) return true
  if (!current || !next) return false
  return current.number === next.number && current.url === next.url
}

export function sameMirroredTicket(
  current: TaskMirroredTicket | undefined,
  next: TaskMirroredTicket | undefined,
): boolean {
  if (current === next) return true
  if (!current || !next) return false
  return current.provider === next.provider
    && current.externalId === next.externalId
    && current.url === next.url
}

export function samePrLinks(
  current: readonly TaskSidebarPrLink[] | undefined,
  next: readonly TaskSidebarPrLink[],
): boolean {
  if (!current || current.length !== next.length) return false
  return current.every((link, index) => {
    const candidate = next[index]
    return !!candidate
      && link.number === candidate.number
      && link.url === candidate.url
      && link.title === candidate.title
      && link.targetScope === candidate.targetScope
      && link.createdBy === candidate.createdBy
      && link.originSessionId === candidate.originSessionId
  })
}
