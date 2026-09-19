import type { ProviderHistoryPage } from '@solus/contracts/session-history'
import { loadCodexHistory, type CodexItemsListParams, type CodexItemsListResponse } from './codex-history'
import type { CodexTurnHistory } from './codex-utils'

/** A turn id is stable while new turns append. Load each older turn once,
 * including all its item pages, to keep call/result correlation intact. */
export async function loadCodexHistoryPage(
  threadId: string,
  turns: CodexTurnHistory[],
  readItems: (params: CodexItemsListParams) => Promise<CodexItemsListResponse>,
  limit: number,
  before?: string,
): Promise<ProviderHistoryPage> {
  const boundary = before === undefined ? turns.length : turns.findIndex((turn) => turn.id === before)
  if (boundary < 0) throw new Error('Session history changed. Reopen the session to load earlier messages.')
  const pages: ProviderHistoryPage['messages'][] = []
  let count = 0
  let index = boundary - 1
  while (index >= 0 && count < limit) {
    const messages = await loadCodexHistory(threadId, [turns[index]], readItems)
    pages.push(messages)
    count += messages.length
    index--
  }
  return {
    messages: pages.reverse().flat(),
    before: index >= 0 ? turns[index + 1].id ?? null : null,
  }
}
