import type { AnnotationsChanged } from '../../shared/types'

type AnnotationsChangedListener = (change: AnnotationsChanged) => void
const listeners = new Set<AnnotationsChangedListener>()

/** Internal domain signal adapted to a host event by the composition root. */
export function onAnnotationsChanged(listener: AnnotationsChangedListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function notifyAnnotationsChanged(change: AnnotationsChanged): void {
  for (const listener of listeners) listener(change)
}
