/**
 * Two or more works written in one turn render as one card: a title that
 * counts them, and one row per work (docs/transcript-cards.md). This module
 * owns what the card line says, so the component stays markup.
 */

import type { WorkType } from '@solus/contracts/types'

/** One work in the stack, as the transcript knows it. */
export type DocumentStackEntry = {
  workId: string
  title: string
  workType?: WorkType
  updatedAt?: string
  streaming: boolean
}

/** "3 documents", "2 decks", "5 files". A mixed write is files, because the
 *  title states what is in the stack and cannot state two types. */
export function stackKicker(types: Array<WorkType | undefined>): string {
  const distinct = new Set(types.map((type) => type ?? 'doc'))
  if (distinct.size > 1) return 'files'
  const [only] = distinct
  if (only === 'slides') return 'decks'
  if (only === 'diagram') return 'diagrams'
  if (only === 'artifact') return 'artifacts'
  return 'documents'
}

/** The card title: the count and the kind, never a written title, because the
 *  stack names works, not an act. */
export function stackTitle(entries: DocumentStackEntry[]): string {
  return `${entries.length} ${stackKicker(entries.map((entry) => entry.workType))}`
}

/** The newest edit across the stack, in epoch ms, or 0 when no entry has a
 *  readable time. The rail shows nothing rather than a false time. */
export function stackLastEditedAt(entries: DocumentStackEntry[]): number {
  return entries.reduce((newest, entry) => {
    const at = entry.updatedAt ? Date.parse(entry.updatedAt) : NaN
    return Number.isNaN(at) ? newest : Math.max(newest, at)
  }, 0)
}
