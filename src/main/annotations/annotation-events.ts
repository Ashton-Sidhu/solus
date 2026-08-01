import type { AnnotationsChanged } from '../../shared/types'

let notifier: ((change: AnnotationsChanged) => void) | null = null

/** Wired to the server's broadcast in `server/index.ts`, mirroring
 *  `setTasksChangedNotifier` — keeps the comment tools free of the server layer. */
export function setAnnotationsChangedNotifier(fn: (change: AnnotationsChanged) => void): void {
  notifier = fn
}

export function notifyAnnotationsChanged(change: AnnotationsChanged): void {
  notifier?.(change)
}
