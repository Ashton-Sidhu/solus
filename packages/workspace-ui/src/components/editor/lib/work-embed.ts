import type { Work } from '@solus/contracts/types'

/** A work the reader may embed, as the picker lists it. */
export interface WorkEmbedChoice {
  workId: string
  title: string
  updatedAt: string
}

/** The slice of the works store an embed node view reads: the work map it
 *  renders from, and the loader that fills in content it has not fetched yet. */
export interface WorkEmbedSource {
  works: Record<string, Work>
  ensureContent(workId: string, source?: string): Promise<Work | null>
}
