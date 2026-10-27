import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ActivityIndicator, FlatList, Pressable, View } from 'react-native'
import { SessionSearch, type HostSessionSearchHit } from '@solus/client-core/session-search'
import { sessionSearchNavigation } from '@solus/client-core/session-search-navigation'
import { snippetRuns } from '@solus/contracts/search-snippet'
import { useApp, useListened } from '../../app/app-context'
import { AppText as Text } from '../../components/AppText'
import { threadKey, type SolusThreadShell, type SolusProjectShell } from '../threads/thread-directory'
import { nativeSearchHomes, nativeSearchHits } from './session-search-list'

/** Native search uses the same paged host search as desktop and web. */
export function SessionSearchResults(props: {
  query: string
  hostId: string | null
  projects: readonly SolusProjectShell[]
  threads: readonly SolusThreadShell[]
  unlistedThreads: readonly SolusThreadShell[]
  projectKeys: ReadonlySet<string> | null
  header: ReactNode
  onSelect: (thread: SolusThreadShell) => void
}) {
  const app = useApp()
  const [, update] = useState(0)
  const [search] = useState(() => new SessionSearch(serverId => {
    const connection = app.connections.connection(serverId)
    if (!connection) throw new Error('This host is unavailable.')
    return connection.api
  }, () => update(value => value + 1)))
  const hosts = useListened(app.registry.changes, () => app.registry.hosts())
  const organizationId = useListened(app.account.changes, () => app.account.organizationId)
  const homes = useMemo(() => nativeSearchHomes(hosts.map(host => host.id), props.projects, { hostId: props.hostId, projectKeys: props.projectKeys }), [hosts, props.hostId, props.projectKeys, props.projects])
  useEffect(() => { search.search(props.query, homes); return () => search.reset() }, [search, props.query, homes, organizationId])
  const state = search.state
  const hits = nativeSearchHits({ query: props.query, hostId: props.hostId, projectKeys: props.projectKeys, threads: [...props.threads, ...props.unlistedThreads], remote: state.hits, organizationId })
  const select = (hit: HostSessionSearchHit) => {
    const record = hit.result.record
    const thread = { key: threadKey(hit.serverId, record.sessionId), hostId: hit.serverId, hostLabel: app.registry.host(hit.serverId)?.label ?? hit.serverId, record }
    app.threads.rememberSearchResult(thread)
    if (hit.result.target && hit.result.reason?.field === 'messages') sessionSearchNavigation.request(hit.serverId, record.sessionId, { target: hit.result.target, query: state.query })
    props.onSelect(thread)
  }
  return <FlatList
    data={hits}
    keyExtractor={hit => `${hit.serverId}:${hit.result.record.sessionId}`}
    keyboardShouldPersistTaps="handled"
    contentInsetAdjustmentBehavior="automatic"
    ListHeaderComponent={<>{props.header}{state.errors.map((error, index) => <Text key={`${error.serverId}:${index}`} className="px-5 py-2 text-sm text-danger-foreground">Search incomplete: {error.message}</Text>)}{state.errors.length > 0 ? <Pressable accessibilityRole="button" className="px-5 py-3" onPress={() => search.search(props.query, homes)}><Text className="text-primary">Retry search</Text></Pressable> : null}</>}
    ListEmptyComponent={!state.loading ? <Text className="px-5 py-6 text-sm text-foreground-muted">No matching sessions.</Text> : undefined}
    ListFooterComponent={state.loading || state.loadingMore ? <View className="p-5"><ActivityIndicator accessibilityLabel="Searching sessions" /></View> : state.remaining > 0 ? <Pressable accessibilityRole="button" className="p-5" onPress={() => void search.loadMore()}><Text className="text-primary">Show more matches</Text></Pressable> : undefined}
    onEndReached={() => void search.loadMore()}
    renderItem={({ item: hit }) => {
      const { record, snippet, reason } = hit.result
      return <Pressable accessibilityRole="button" className="gap-1 border-b border-border px-5 py-3 active:opacity-70" onPress={() => select(hit)}>
        <Text numberOfLines={1} className="text-sm font-t3-medium text-primary-text">{record.customTitle || record.title || record.slug || 'Unnamed session'}</Text>
        <Text numberOfLines={2} className="text-sm text-foreground-muted">{reason?.field === 'messages' ? snippetRuns(snippet).map((run, index) => <Text key={index} className={run.hit ? 'font-t3-bold' : undefined}>{run.text}</Text>) : reason ? `${reason.field === 'id' ? 'ID' : reason.field === 'pullRequest' ? 'PR' : reason.field === 'branch' ? 'Branch' : 'Title'}: ${reason.text}` : record.branch}</Text>
        <Text numberOfLines={1} className="text-xs text-foreground-tertiary">{app.registry.host(hit.serverId)?.label} · {record.provider}</Text>
      </Pressable>
    }}
  />
}
