import type { Work, WorkAnnotations, WorkRevision } from './types'

/**
 * An exact work snapshot for a one-way cloud push: the current work, its whole
 * immutable history, and its comments, read in one transaction. The
 * destination assigns the organization; everything else keeps its identity.
 * The fingerprint covers all of it and protects source deletion when the body,
 * history, or comments change while the request is in flight. History is never
 * truncated.
 */
export interface WorkTransfer {
  /** The current work, with its `contentVersion`, `contentHash`, and author.
   *  Its `organizationId` is the source's fact, not the destination's. */
  work: Work
  /** The revision the previous-version comparison and revert use: one of
   *  `revisions`, or null. */
  previousRevisionId: number | null
  /** Every checkpoint of this work, oldest first, under the `revisionId` it
   *  has at the source, with its body, author, version, and hash. */
  revisions: WorkRevision[]
  annotations: WorkAnnotations | null
  fingerprint: string
}
