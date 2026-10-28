import { z } from 'zod'
import type { SolusEventMap, Via } from '@solus/contracts/analytics-events'
import { SearchQuery } from '@solus/contracts/search-query'
import type { PickerEntry, PickerList } from './picker-rows'
import type { PickerSort } from './picker-search'

/**
 * Where the row a person chose sat, and whether the same query chose the
 * same row before. This measures whether remembering a query's pick (as
 * t3code's search does) would help before it is built: a pick only helps when
 * the same query keeps choosing the same row and that row is not first.
 *
 * The event never holds the query or what was chosen. To know whether a query
 * repeats, this device keeps hashes of recent queries and of the rows chosen
 * for them; they never leave it.
 */
const MEMORY_KEY = 'solus-picker-pick-memory'
const MEMORY_LIMIT = 200
const MEMORY_DAYS = 21
const DAY_MS = 86_400_000

const memorySchema = z.array(z.object({ query: z.string(), row: z.string(), at: z.number() }))
type RememberedPick = z.infer<typeof memorySchema>[number]

/** FNV-1a: enough to tell queries apart without storing them. */
function hash(text: string): string {
  let value = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    value ^= text.charCodeAt(index)
    value = Math.imul(value, 0x01000193)
  }
  return (value >>> 0).toString(36)
}

/** The section heading above the entry, as the reader saw it. */
function sectionOf(list: PickerList, entry: PickerEntry): SolusEventMap['session_search_picked']['section'] {
  let section: SolusEventMap['session_search_picked']['section'] = 'none'
  for (const row of list.rows) {
    if (row === entry) return section
    if (row.kind !== 'header') continue
    const key = row.key.slice('header:'.length)
    section = key === 'top' || key === 'tasks' || key === 'sessions' || key === 'messages' ? key : 'other'
  }
  return section
}

function matchedIn(entry: PickerEntry): string {
  if (entry.kind === 'task') return entry.matchedIn ?? 'none'
  return entry.reason?.field ?? 'none'
}

/** Whether this query was chosen from before, and for the same row. Records this choice. */
export function rememberPick(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  words: readonly string[],
  rowKey: string,
  now: number,
): SolusEventMap['session_search_picked']['repeat'] {
  const query = hash(words.join(' '))
  const row = hash(rowKey)
  let memory: RememberedPick[] = []
  try {
    memory = memorySchema.parse(JSON.parse(storage.getItem(MEMORY_KEY) ?? '[]'))
  } catch {
    // A memory that does not read is started again.
  }
  memory = memory.filter(item => now - item.at <= MEMORY_DAYS * DAY_MS)
  const before = memory.find(item => item.query === query)
  const repeat = !before ? 'new' : before.row === row ? 'same_choice' : 'other_choice'
  memory = [{ query, row, at: now }, ...memory.filter(item => item.query !== query)].slice(0, MEMORY_LIMIT)
  try {
    storage.setItem(MEMORY_KEY, JSON.stringify(memory))
  } catch {
    // Without storage, every query reads as new.
  }
  return repeat
}

/** The event for a choice under a query, or null when the box is empty. */
export function pickedEvent(input: {
  list: PickerList
  entry: PickerEntry
  query: string
  sort: PickerSort
  via: Via
  storage: Pick<Storage, 'getItem' | 'setItem'>
  now: number
}): SolusEventMap['session_search_picked'] | null {
  const { words } = new SearchQuery(input.query)
  if (!words.length) return null
  return {
    position: input.entry.entryIndex + 1,
    section: sectionOf(input.list, input.entry),
    kind: input.entry.kind,
    matched_in: matchedIn(input.entry),
    query_words: words.length,
    sort: input.sort,
    repeat: rememberPick(input.storage, words, input.entry.key, input.now),
    via: input.via,
  }
}
