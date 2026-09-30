import type { Work, WorkMeta } from '@solus/contracts/types'

/** A work the reader may embed, as the picker lists it. */
export interface WorkEmbedChoice {
  workId: string
  title: string
  updatedAt: string
}

/** The slice of the works store an embed node view reads: the listing that
 *  names the work, the saved records it renders from, and the loader that
 *  reads a saved record it does not hold yet. */
export interface WorkEmbedSource {
  works: Record<string, WorkMeta & { id: string }>
  saved: Record<string, Work>
  ensureContent(workId: string, source?: string): Promise<Work | null>
}
