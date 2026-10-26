import { z } from 'zod'
import { historyPageIsFull, type ProviderHistoryPage, type SessionLoadMessage } from '@solus/contracts/session-history'
import { CODEX_ITEM_PAGE, type CodexItemsListParams, type CodexItemsListResponse } from './codex-history'
import { codexItemToMessage, completeCodexTurnMessages, toEpochMs, type CodexTurnHistory } from './codex-utils'

type ReadItems = (params: CodexItemsListParams) => Promise<CodexItemsListResponse>

/** `turn` alone is the boundary before that turn. With `skip`, the page was cut
 * inside the turn: read its item page `items` again, past the `skip` newest
 * entries already given; `last` is the id of the last entry given, if it had one. */
const cursorSchema = z.object({
  turn: z.string(),
  items: z.string().optional(),
  skip: z.number().int().positive().optional(),
  last: z.string().optional(),
})
type Cursor = z.infer<typeof cursorSchema>

/** What the page holds so far, counted against `historyPageIsFull`. */
interface PageBudget { rows: number; bytes: number }

const historyChanged = () => new Error('Session history changed. Reopen the session to load earlier messages.')

function parseCursor(before: string): Cursor {
  try {
    return cursorSchema.parse(JSON.parse(before))
  } catch {
    throw historyChanged()
  }
}

/** One item page of a turn, newest first. */
async function readItemPage(threadId: string, turn: CodexTurnHistory, readItems: ReadItems, cursor: string | undefined): Promise<CodexItemsListResponse> {
  if (turn.itemsView === 'summary' || turn.itemsView === 'notLoaded') {
    if (!turn.id) throw new Error('Codex history summary has no turn id')
    return readItems({ threadId, turnId: turn.id, cursor, limit: CODEX_ITEM_PAGE, sortDirection: 'desc' })
  }
  // Older runtimes omit itemsView and return complete items in thread/read.
  return { data: (turn.items ?? []).map((item) => ({ turnId: turn.id ?? '', item })).reverse(), nextCursor: null }
}

/** A turn's items from its end, or from `resume`, back to its first item or
 * until the page budget is full. `cut` is the cursor of the items left. */
async function readTurn(
  threadId: string, turn: CodexTurnHistory, readItems: ReadItems, budget: PageBudget, resume: Cursor | undefined,
): Promise<{ messages: SessionLoadMessage[]; cut?: string }> {
  const startedAt = toEpochMs(turn.startedAt)
  const newest: SessionLoadMessage[] = []
  let items = resume?.items
  let skip = resume?.skip ?? 0
  let last = resume?.last
  const seenCursors = new Set<string>()
  for (;;) {
    const page = await readItemPage(threadId, turn, readItems, items)
    // An item page that changed since the cursor was made cannot resume it.
    if (skip > page.data.length || (last !== undefined && page.data[skip - 1]?.item.id !== last)) throw historyChanged()
    for (let entry = skip; entry < page.data.length; entry++) {
      const { item } = page.data[entry]
      budget.bytes += Buffer.byteLength(JSON.stringify(item))
      const message = codexItemToMessage(item, startedAt)
      if (message) {
        newest.push(message)
        budget.rows++
      }
      const hasOlder = entry + 1 < page.data.length || Boolean(page.nextCursor)
      if (turn.id && hasOlder && historyPageIsFull(budget.rows, budget.bytes)) {
        return { messages: newest.reverse(), cut: JSON.stringify({ turn: turn.id, items, skip: entry + 1, last: item.id }) }
      }
    }
    skip = 0
    last = undefined
    items = page.nextCursor ?? undefined
    if (!items) return { messages: newest.reverse() }
    if (seenCursors.has(items)) throw new Error('Codex history repeated an item cursor')
    seenCursors.add(items)
  }
}

/** The `turnLimit` turns before the cursor, newest first, within the page's
 * row and byte budget (`historyPageIsFull`). Ordinary turns arrive whole. A
 * turn longer than the budget is cut between items: the page starts inside the
 * turn, and the next older page gives back its earlier items. A turn id is
 * stable while new turns append. */
export async function loadCodexHistoryPage(
  threadId: string,
  turns: CodexTurnHistory[],
  readItems: ReadItems,
  turnLimit: number,
  before?: string,
): Promise<ProviderHistoryPage> {
  const cursor = before === undefined ? undefined : parseCursor(before)
  const boundary = cursor ? turns.findIndex((turn) => turn.id === cursor.turn) : turns.length
  if (boundary < 0) throw historyChanged()
  let resume = cursor?.skip ? cursor : undefined
  const loaded: SessionLoadMessage[][] = []
  const budget: PageBudget = { rows: 0, bytes: 0 }
  let complete = 0
  for (let index = resume ? boundary : boundary - 1; index >= 0; index--) {
    const turn = turns[index]
    const { messages, cut } = await readTurn(threadId, turn, readItems, budget, resume)
    // Turn timing and failure belong to the turn's end, so only the page that holds it applies them.
    loaded.push(resume ? messages : completeCodexTurnMessages(turn, messages))
    resume = undefined
    if (cut) return { messages: loaded.reverse().flat(), before: cut }
    if ((++complete >= turnLimit || historyPageIsFull(budget.rows, budget.bytes)) && index > 0) {
      return { messages: loaded.reverse().flat(), before: turn.id ? JSON.stringify({ turn: turn.id }) : null }
    }
  }
  return { messages: loaded.reverse().flat(), before: null }
}
