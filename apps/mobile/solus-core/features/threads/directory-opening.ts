import type { SessionDirectoryPage, SolusAPI } from '@solus/contracts/host-api'
import type { SessionRecordList } from '@solus/contracts/types'

export function directoryOpeningRows(page: SessionDirectoryPage) {
  return [...page.records, ...page.pinnedRecords.filter(row => row.listed !== false && !row.parentSessionId)]
}

export async function remainingDirectoryRows(api: Pick<SolusAPI, 'sessionRecordList'>, page: SessionDirectoryPage): Promise<SessionRecordList> {
  const first = directoryOpeningRows(page)
  if (!page.nextCursor) return { records: first, indexing: page.indexing, revision: page.revision }
  const rest = await api.sessionRecordList({ includeWorktrees: true, cursor: page.nextCursor })
  // Activity can change while paging. Keep each session once, with its newest answer.
  const records = new Map(first.map(row => [row.sessionId, row]))
  for (const row of rest.records) records.set(row.sessionId, row)
  return { records: [...records.values()], indexing: page.indexing || rest.indexing }
}
