// Adapted from T3 Code apps/mobile/src/features/pull-requests/usePullRequestList.ts (MIT, see UPSTREAM.md).
import { useFocusEffect } from '@react-navigation/native'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useApp, useListened } from '../../app/app-context'
import type { PullRequestListProject } from '../workspace/list-preferences'
import { FOCUS_FRESH_MS, type PullRequestListFilter } from './pull-request-directory'
import { PullRequestListSelection } from './pull-request-list-selection'

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

  // The read states, for notices and spinners, apart from the rows they show:
  // a read that answers what the list shows already renders no row again.
  const selection = useMemo(() => new PullRequestListSelection(directory), [directory])
  const hosts = useListened(directory.changes, useCallback(() => selection.hosts(targets), [selection, targets]))
  const rows = useListened(directory.changes, useCallback(() => selection.rows(targets), [selection, targets]))

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
  // The projects in scope that have another page, by host.
  const more = useMemo(() => hosts.flatMap(({ hostId, state: read }) => {
    if (read.kind !== 'loaded') return []
    const paths = read.value.projects
      .filter((entry) => entry.kind === 'page' && entry.hasMore && (!project || (project.hostId === hostId && project.projectPath === entry.projectPath)))
      .map((entry) => entry.projectPath)
    return paths.length ? [{ hostId, paths }] : []
  }), [hosts, project])
  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current) return
    const work = more
    if (work.length === 0) return
    loadingMoreRef.current = true
    setLoadingMore(true)
    await Promise.all(work.map(async ({ hostId, paths }) => {
      for (const path of paths) await directory.loadMore(hostId, path)
    }))
    loadingMoreRef.current = false
    setLoadingMore(false)
  }, [directory, more])
  const hasMore = more.length > 0
  const reading = hosts.some(({ state: read }) => read.kind === 'idle' || read.kind === 'loading')

  return { hosts, rows, connectedHostIds, refreshing, refresh, reading, hasMore, loadingMore, loadMore, reloadHost: (hostId: string) => void directory.loadHost(hostId) }
}
