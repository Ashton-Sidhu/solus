import type { ProviderHistoryPage } from '@solus/contracts/session-history'
import { loadCodexHistory, type CodexItemsListParams, type CodexItemsListResponse } from './codex-history'
import type { CodexTurnHistory } from './codex-utils'

/** A turn id is stable while new turns append. Load each of the `turnLimit`
 * older turns once, including all its item pages, to keep call/result
 * correlation intact. */
export async function loadCodexHistoryPage(
  threadId: string,
  turns: CodexTurnHistory[],
  readItems: (params: CodexItemsListParams) => Promise<CodexItemsListResponse>,
  turnLimit: number,
  before?: string,
): Promise<ProviderHistoryPage> {
  const boundary = before === undefined ? turns.length : turns.findIndex((turn) => turn.id === before)
  if (boundary < 0) throw new Error('Session history changed. Reopen the session to load earlier messages.')
  const start = Math.max(0, boundary - turnLimit)
  const pages: ProviderHistoryPage['messages'][] = []
  for (let index = start; index < boundary; index++) {
    pages.push(await loadCodexHistory(threadId, [turns[index]], readItems))
  }
  return {
    messages: pages.flat(),
    before: start > 0 ? turns[start].id ?? null : null,
  }
}
