import type { WorkspaceOperations } from '../../data/workspace/operations'

/**
 * The Solus API operations, where a read of the session list or a session
 * search also asks the providers to refresh their session indexes, so a
 * session started outside Solus (in the Codex CLI) comes into the list. Only
 * the first page asks: the next pages are the same read.
 */
export function refreshingSessionIndexOnList(operations: WorkspaceOperations, requestRefresh: () => void): WorkspaceOperations {
  return {
    ...operations,
    listSessions: (context, query) => {
      if (!query.cursor) requestRefresh()
      return operations.listSessions(context, query)
    },
    searchSessions: (context, query) => {
      requestRefresh()
      return operations.searchSessions(context, query)
    },
  }
}
