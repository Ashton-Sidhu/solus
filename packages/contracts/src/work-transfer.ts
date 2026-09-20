import type { Work, WorkAnnotations, WorkPrevious } from './types'

/** An exact work snapshot for a one-way cloud push. The fingerprint protects
 * source deletion when content or comments change while the request is in flight. */
export interface WorkTransfer {
  work: Work
  annotations: WorkAnnotations | null
  previous: WorkPrevious | null
  fingerprint: string
}
