import { useCallback, useEffect, useMemo } from 'react'
import { useApp, useListened } from '../../app/app-context'
import {
  PullRequestListMetadata,
  prMetadataKey,
  prMetadataRowsKey
} from './pull-request-list-metadata'
import type { PullRequestListFilters, PullRequestRow } from './lib/pull-request-list'

/** Saved review filters read host records only when selected, and never report an empty list while reading. */
export function usePrReviewFilters(
  loadedRows: PullRequestRow[],
  filters: PullRequestListFilters,
  reading: boolean
) {
  const app = useApp()
  const identity = useListened(app.account.changes, () =>
    JSON.stringify([app.account.syncAccount, app.account.organizationId])
  )
  const owner = useMemo(
    () =>
      new PullRequestListMetadata(
        (hostId) => {
          if (JSON.stringify([app.account.syncAccount, app.account.organizationId]) !== identity)
            return null
          return app.connections.connection(hostId)
        },
        () => app.account.organizationId
      ),
    [app, identity]
  )
  useEffect(() => () => owner.reset(), [owner])
  const metadata = useListened(owner.changes, owner.current)
  const needed = !!(filters.guide || filters.lens)
  const key = prMetadataRowsKey(loadedRows)
  const pending = needed && (metadata.pending || metadata.rowsKey !== key)
  const retry = useCallback(() => {
    void owner.load(loadedRows)
  }, [owner, loadedRows])
  useEffect(() => {
    if (needed && !reading) retry()
  }, [identity, needed, reading, retry])
  const rows = useMemo(
    () =>
      needed
        ? loadedRows.filter((row) => {
            const held = metadata.values.get(prMetadataKey(row))
            return (!filters.guide || held?.guide) && (!filters.lens || held?.lens)
          })
        : loadedRows,
    [loadedRows, needed, filters.guide, filters.lens, metadata]
  )
  return {
    rows,
    pending,
    waiting: reading || pending,
    error: needed ? metadata.error : null,
    retry,
    filterKey: JSON.stringify([filters.guide, filters.lens])
  }
}
