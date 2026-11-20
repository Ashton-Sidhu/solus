import { startsHistoryTurn, type ProviderHistoryPage, type WireSessionLoadMessage } from '@solus/contracts/session-history'
import { projectSessionHistory } from '../../data/sessions/result-projection'

/** Find the turn that had ended at `endedAt`, even if later turns are already in the provider history. */
export async function loadSettledTurnRows(endedAt: number, loadPage: (before?: string) => Promise<ProviderHistoryPage>): Promise<WireSessionLoadMessage[] | null> {
  let before: string | undefined
  for (;;) {
    const page = await loadPage(before)
    const start = page.messages.find(startsHistoryTurn)
    if (start && start.timestamp <= endedAt) {
      // The provider's hard page budget can cut a turn. Do not archive a partial turn.
      if (!startsHistoryTurn(page.messages[0])) return null
      return projectSessionHistory(page.messages)
    }
    if (!page.before || page.before === before) return null
    before = page.before
  }
}
