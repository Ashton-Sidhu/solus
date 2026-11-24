import { z } from 'zod'

/**
 * A person's history (docs/plans/person-state.md §4): when they last opened
 * each record. It is kept in the person's home: the Solus API in their own
 * scope while signed in, else their device host. It is not a log: one entry
 * for each record, and the later time wins.
 */

/** The kinds of record a history key names. The kind is the key's text before its first colon. */
export const PERSON_HISTORY_KINDS = ['work', 'app', 'file', 'image'] as const
export type PersonHistoryKind = (typeof PERSON_HISTORY_KINDS)[number]

/** A home keeps this many entries for each person: the newest. */
export const PERSON_HISTORY_LIMIT = 500

/** One record call takes at most this many entries. */
export const PERSON_HISTORY_BATCH_LIMIT = 100

/** A key longer than this is not a record key (a file path is the longest part). */
const KEY_MAX_LENGTH = 2048

function isPersonHistoryKind(value: string): value is PersonHistoryKind {
  return PERSON_HISTORY_KINDS.some((kind) => kind === value)
}

/** The kind a key names, or null when the key names no history kind. */
export function personHistoryKindOf(key: string): PersonHistoryKind | null {
  const kind = key.slice(0, key.indexOf(':'))
  return isPersonHistoryKind(kind) ? kind : null
}

export const personHistoryEntrySchema = z.object({
  /** The record: `work:<workId>`, `app:<hostId>:<appId>`, `file:<hostId>:<path>`, or `image:<hostId>:<path>`. */
  key: z.string().min(3).max(KEY_MAX_LENGTH).refine((key) => personHistoryKindOf(key) !== null, 'The key names no history kind.'),
  /** When the person opened it, epoch ms. */
  openedAt: z.number().int().nonnegative(),
})

export type PersonHistoryEntry = z.infer<typeof personHistoryEntrySchema>

export const personHistoryBatchSchema = z.array(personHistoryEntrySchema).max(PERSON_HISTORY_BATCH_LIMIT)
