// Adapted from T3 Code apps/mobile/src/features/pull-requests/usePullRequestList.ts (MIT, see UPSTREAM.md).
import { useFocusEffect } from '@react-navigation/native'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useApp, useListened } from '../../app/app-context'
import type { PullRequestListProject } from '../workspace/list-preferences'
import { pullRequestRows } from './lib/pull-request-list'
import { FOCUS_FRESH_MS, type HostPullRequests, type PullRequestListFilter } from './pull-request-directory'
import { shownValue, type LoadState } from './pull-request-reads'

/**
 * The Pull Requests tab's reads: every host in `hostIds` with the host-side
 * filter, read when the filter changes, when a host connects again, and when
 * the tab shows after `FOCUS_FRESH_MS`. While the tab shows, PR sync on each
 * host pushes the changes of the pull requests it tracks, and a host whose
 * agent turn ended in a listed repository is read again. T3 keeps
 * pages in atoms; Solus reads them from `app.pullRequests`, which also keeps
 * the device copy for offline use.
 */
export function usePullRequestList(hostIds: readonly string[], filter: PullRequestListFilter, project: PullRequestListProject | null) {
  const app = useApp()
  const directory = app.pullRequests
  const hostKey = hostIds.join('\u0000')
  const { state, query } = filter
  // `hostKey` names the same hosts as `hostIds`, so a new array of the same hosts reads nothing again.
  const targets = useMemo(() => hostIds, [hostKey])

  const load = useCallback((options: { freshFor?: number } = {}) => {
    directory.setListFilter({ state, query })
    return directory.loadHosts(targets, options)
  }, [directory, state, query, targets])
  useFocusEffect(useCallback(() => { void load({ freshFor: FOCUS_FRESH_MS }) }, [load]))

  // A host that connects again is read again; the others keep what they show.
  const connectedKey = useListened(app.connections.changes, () => targets.filter((hostId) => app.connections.state(hostId)?.phase === 'connected').join('\u0000'))
  const connected = useRef(connectedKey)
  useEffect(() => {
    const before = new Set(connected.current.split('\u0000'))
    connected.current = connectedKey
    const reconnected = connectedKey.split('\u0000').filter((hostId) => hostId && !before.has(hostId))
    if (reconnected.length > 0) void directory.loadHosts(reconnected)
  }, [directory, connectedKey])

  const connectedHostIds = useMemo(() => new Set(connectedKey.split('\u0000')), [connectedKey])

  const revision = useListened(directory.changes, () => directory.revision)
  const hosts = useMemo(
    (): { hostId: string; state: LoadState<HostPullRequests> }[] => targets.map((hostId) => ({ hostId, state: directory.hostOf(hostId) })),
    // `revision` counts every directory change.
    [directory, targets, revision],
  )
  const rows = useMemo(() => pullRequestRows(hosts.map(({ hostId, state: read }) => ({ hostId, listing: shownValue(read) }))), [hosts])

  // While the tab shows, a host that says a listed repository changed is read again.
  useFocusEffect(useCallback(() => directory.showList(), [directory]))

  const [refreshing, setRefreshing] = useState(false)
  const refresh = useCallback(async () => {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }, [load])

  // One page at a time for each host: the host's listing is one read, and a
  // newer read of it drops the older one.
  const [loadingMore, setLoadingMore] = useState(false)
  const loadingMoreRef = useRef(false)
  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current) return
    const work = hosts.flatMap(({ hostId, state: read }) => {
      if (read.kind !== 'loaded') return []
      const paths = read.value.projects
        .filter((entry) => entry.kind === 'page' && entry.hasMore && (!project || (project.hostId === hostId && project.projectPath === entry.projectPath)))
        .map((entry) => entry.projectPath)
      return paths.length ? [{ hostId, paths }] : []
    })
    if (work.length === 0) return
    loadingMoreRef.current = true
    setLoadingMore(true)
    await Promise.all(work.map(async ({ hostId, paths }) => {
      for (const path of paths) await directory.loadMore(hostId, path)
    }))
    loadingMoreRef.current = false
    setLoadingMore(false)
  }, [directory, hosts, project])

  return { hosts, rows, connectedHostIds, refreshing, refresh, loadingMore, loadMore, reloadHost: (hostId: string) => void directory.loadHost(hostId) }
}
