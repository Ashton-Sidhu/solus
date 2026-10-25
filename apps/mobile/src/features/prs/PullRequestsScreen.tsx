// Adapted from T3 Code apps/mobile/src/features/pull-requests/PullRequestsScreen.tsx (MIT, see UPSTREAM.md).
import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, FlatList, Keyboard, Platform, Pressable, RefreshControl, ScrollView, View, type ScrollViewProps } from 'react-native'
import { ScrollViewMarker } from 'react-native-screens'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { BoundedPageFill } from '@solus/client-core/bounded-page-fill'
import { useApp, useListened } from '../../app/app-context'
import { AppText as Text } from '../../components/AppText'
import { EmptyState } from '../../components/EmptyState'
import type { RootStackParamList } from '../../navigation/routes'
import { resolvePullRequestListScope, type PullRequestListPreferences } from '../workspace/list-preferences'
import { PullRequestCardGroup, PullRequestCardRow } from './detail/pull-request-ui'
import { prUnavailableTitle } from './lib/pr-presentation'
import { filterPullRequestRows, hostNoticesSummary, pullRequestHostQuery, pullRequestListFacets, pullRequestRowKey, type PullRequestRow } from './lib/pull-request-list'
import { PullRequestListFilters, type PullRequestFilterProject } from './PullRequestListFilters'
import { PullRequestListRow } from './PullRequestListRow'
import { shownValue } from './pull-request-reads'
import { usePullRequestList } from './use-pull-request-list'

/** T3 waits this long after the last keystroke before the hosts search. */
const SEARCH_DELAY_MS = 180

function useDebouncedValue(value: string, delay: number): string {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return debounced
}

/**
 * iOS: register the list with the native header so UIKit samples the list's
 * own surface for the scroll-edge material, and inset the content by hand so
 * the resting top sits under the bar. Without the marker the bar draws a grey
 * band over the filter pills.
 */
function PullRequestScrollView(props: ScrollViewProps) {
  const insets = useSafeAreaInsets()
  // The marker is the list's outer view: without flex it has no height, and the list shows nothing.
  return (
    <ScrollViewMarker style={{ flex: 1 }}>
      <ScrollView
        {...props}
        automaticallyAdjustContentInsets={false}
        contentInsetAdjustmentBehavior="never"
        contentOffset={props.contentOffset ?? { x: 0, y: -insets.top }}
      />
    </ScrollViewMarker>
  )
}

/** FlatList calls this as a plain function, so the hooks live in the component it returns. */
function renderPullRequestScrollView(props: ScrollViewProps) {
  return <PullRequestScrollView {...props} />
}

/** Why one host's rows are missing or old, and what the person can do. */
interface HostNotice {
  key: string
  title: string
  detail: string
  actionLabel: string | null
  onAction: (() => void) | null
}

/**
 * The host notices above the list. With a summary they fold into one compact
 * row that shows or hides them (T3 #21389).
 */
function HostNotices(props: { readonly notices: readonly HostNotice[]; readonly summary: string | null }) {
  const [expanded, setExpanded] = useState(false)
  const shown = props.summary === null || expanded
  return (
    <>
      {props.summary !== null ? (
        <View className="mx-4 mb-2">
          <PullRequestCardGroup>
            <PullRequestCardRow
              title={props.summary}
              icon="exclamationmark.triangle"
              compact
              last
              expanded={expanded}
              accessibilityLabel={`${props.summary}. ${expanded ? 'Hide' : 'Show'} details`}
              onPress={() => setExpanded((value) => !value)}
            />
          </PullRequestCardGroup>
        </View>
      ) : null}
      {shown ? props.notices.map((notice) => (
        <View key={notice.key} className="mx-4 mb-2 rounded-[20px] border border-border bg-card p-4">
          <Text className="text-sm font-t3-bold text-foreground">{notice.title}</Text>
          <Text className="mt-1 text-sm text-foreground-muted">{notice.detail}</Text>
          {notice.actionLabel && notice.onAction ? (
            <Pressable accessibilityRole="button" className="mt-2 self-start active:opacity-60" onPress={notice.onAction}>
              <Text className="text-sm font-t3-bold text-primary-text">{notice.actionLabel}</Text>
            </Pressable>
          ) : null}
        </View>
      )) : null}
    </>
  )
}

/**
 * The Pull Requests tab: the pull requests of every paired host in one list,
 * newest activity first. The hosts answer the state, the search text, and the
 * label, author and draft filters; the other pill filters narrow the rows on
 * the device. A host that cannot be read now
 * shows its device copy with a notice, or says why it shows nothing.
 */
export function PullRequestsScreen(props: {
  readonly query: string
  readonly preferences: PullRequestListPreferences
  readonly onPreferencesChange: (preferences: PullRequestListPreferences) => void
}) {
  const app = useApp()
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>()
  const insets = useSafeAreaInsets()
  const registryHosts = useListened(app.registry.changes, app.registry.hosts)
  const hostLabels = useMemo(() => new Map(registryHosts.map((host) => [host.id, host.label])), [registryHosts])
  const hostOptions = useMemo(
    () => registryHosts.map((host) => ({ id: host.id, label: host.label })).sort((left, right) => left.label.localeCompare(right.label)),
    [registryHosts],
  )
  const pairedHostIds = useMemo(() => hostOptions.map((host) => host.id), [hostOptions])
  const { preferences, onPreferencesChange } = props
  const scope = useMemo(() => resolvePullRequestListScope(preferences, pairedHostIds), [preferences, pairedHostIds])
  const typed = useDebouncedValue(props.query.trim(), SEARCH_DELAY_MS)
  const query = useMemo(() => pullRequestHostQuery(typed, preferences.filters), [typed, preferences.filters])
  const list = usePullRequestList(scope.hostIds, { state: preferences.state, query }, scope.project)

  const viewerOf = useMemo(() => {
    const viewers = new Map(list.hosts.map((host) => [host.hostId, shownValue(host.state)?.viewerLogin ?? null]))
    return (hostId: string) => viewers.get(hostId) ?? null
  }, [list.hosts])
  const rows = useMemo(() => filterPullRequestRows(list.rows, scope.controls, viewerOf, list.connectedHostIds), [list.rows, scope.controls, viewerOf, list.connectedHostIds])
  const facets = useMemo(() => pullRequestListFacets(list.rows), [list.rows])

  // Review, checks, involvement, host and project narrow only the rows the
  // device holds, so a filtered page can come back short. Read a few more
  // pages while it is.
  const [pageFill] = useState(() => new BoundedPageFill())
  const fillKey = JSON.stringify([query, preferences.state, scope.hostIds, scope.project, scope.controls.involvement, scope.controls.filters.review, scope.controls.filters.checks])
  const { reading, hasMore, loadingMore, loadMore } = list
  useEffect(() => {
    if (pageFill.next(fillKey, { rows: rows.length, hasMore, reading: reading || loadingMore })) void loadMore()
  }, [pageFill, fillKey, rows.length, hasMore, reading, loadingMore, loadMore])
  const showsHost = scope.hostIds.length > 1
  const projects = useMemo((): PullRequestFilterProject[] => {
    const result: PullRequestFilterProject[] = []
    for (const hostId of scope.hostId ? [scope.hostId] : pairedHostIds) {
      for (const project of shownValue(app.pullRequests.hostOf(hostId))?.projects ?? []) {
        const hostLabel = hostLabels.get(hostId)
        result.push({ hostId, projectPath: project.projectPath, label: scope.hostId || !hostLabel ? project.folderName : `${project.folderName} · ${hostLabel}` })
      }
    }
    // A saved project stays a choice while its host has not listed it.
    const saved = scope.project
    if (saved && !result.some((project) => project.hostId === saved.hostId && project.projectPath === saved.projectPath)) {
      result.push({ ...saved, label: saved.projectPath.split(/[\\/]/).filter(Boolean).at(-1) ?? saved.projectPath })
    }
    return result
    // `list.hosts` changes when a shown host's read changes; only those reads change the projects here.
  }, [app, list.hosts, scope.hostId, scope.project, pairedHostIds, hostLabels])

  const openPullRequest = useCallback((row: PullRequestRow) => {
    Keyboard.dismiss()
    navigation.navigate('PullRequest', { hostId: row.hostId, projectPath: row.projectPath, number: row.pr.number })
  }, [navigation])

  const reads = list.hosts.map((host) => ({ ...host, label: hostLabels.get(host.hostId) ?? 'This host' }))
  const allNeedGithub = reads.length > 0 && reads.every((host) => host.state.kind === 'error' && host.state.githubAuth)
  const notices = rows.length === 0 && allNeedGithub ? [] : reads.flatMap((host): HostNotice[] => {
    const read = host.state
    if (read.kind !== 'error') return []
    if (read.githubAuth) {
      return [{ key: host.hostId, title: `GitHub is not connected on ${host.label}`, detail: `${host.label} reads pull requests with its own GitHub connection.`, actionLabel: 'Connect GitHub', onAction: () => navigation.navigate('GitHubConnection', { hostId: host.hostId }) }]
    }
    if (read.offline) {
      return [{
        key: host.hostId,
        title: read.previous ? `Not refreshed: ${host.label} is offline` : `${host.label} is offline`,
        detail: read.previous ? 'These pull requests are the copy saved on this device.' : 'Reconnect to load pull requests that are not saved on this device.',
        actionLabel: null,
        onAction: null,
      }]
    }
    return [{ key: host.hostId, title: `Could not read pull requests on ${host.label}`, detail: read.message, actionLabel: 'Try again', onAction: () => list.reloadHost(host.hostId) }]
  })
  const notShown = reads.flatMap((host) => (shownValue(host.state)?.projects ?? []).flatMap((project) => {
    if (scope.project && (scope.project.hostId !== host.hostId || scope.project.projectPath !== project.projectPath)) return []
    if (project.kind === 'unavailable') return [{ key: `${host.hostId}:${project.projectPath}`, text: prUnavailableTitle(project.reason, project.folderName) }]
    if (project.kind === 'error') return [{ key: `${host.hostId}:${project.projectPath}`, text: `${project.folderName}: ${project.message}` }]
    return []
  }))
  const waiting = list.rows.length === 0 && reads.some((host) => host.state.kind === 'idle' || host.state.kind === 'loading')

  return (
    <FlatList
      className="flex-1 bg-screen"
      renderScrollComponent={Platform.OS === 'ios' ? renderPullRequestScrollView : undefined}
      contentInsetAdjustmentBehavior="never"
      contentInset={Platform.OS === 'ios' ? { top: insets.top } : undefined}
      scrollIndicatorInsets={Platform.OS === 'ios' ? { top: insets.top } : undefined}
      contentContainerStyle={{ paddingBottom: Platform.OS === 'ios' ? Math.max(insets.bottom, 24) + 16 : Math.max(insets.bottom, 16) + 16 }}
      data={rows}
      keyExtractor={pullRequestRowKey}
      renderItem={({ item }) => (
        <PullRequestListRow row={item} hostLabel={showsHost ? (hostLabels.get(item.hostId) ?? null) : null} onSelect={openPullRequest} />
      )}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      onEndReached={() => void list.loadMore()}
      onEndReachedThreshold={0.5}
      refreshControl={
        <RefreshControl
          refreshing={list.refreshing}
          onRefresh={() => void list.refresh()}
          // Place the native refresh control in the revealed pull-down space under the bar.
          progressViewOffset={Platform.OS === 'ios' ? 60 : undefined}
        />
      }
      ListHeaderComponent={pairedHostIds.length > 0 ? (
        <>
          <PullRequestListFilters
            hosts={hostOptions}
            hostId={scope.hostId}
            project={scope.project}
            value={preferences}
            onChange={onPreferencesChange}
            authors={facets.authors}
            labels={facets.labels}
            projects={projects}
          />
          <HostNotices
            // A new scope starts folded again.
            key={`${scope.hostIds.join(',')}\u0000${scope.project?.hostId ?? ''}\u0000${scope.project?.projectPath ?? ''}`}
            notices={notices}
            summary={hostNoticesSummary(notices.length, rows.length)}
          />
        </>
      ) : undefined}
      ListEmptyComponent={
        pairedHostIds.length === 0 ? (
          <EmptyState
            variant="plain"
            title="Connect a host"
            detail="Pull requests of your hosts’ projects appear here."
            actionLabel="Connect a host"
            onAction={() => navigation.navigate('PairHost')}
          />
        ) : waiting ? (
          <View className="items-center py-12">
            <ActivityIndicator colorClassName="accent-icon" accessibilityLabel="Loading pull requests" />
          </View>
        ) : allNeedGithub ? (
          <EmptyState
            variant="plain"
            title="Connect GitHub to see pull requests"
            detail={`${reads[0]!.label} reads pull requests with its own GitHub connection.`}
            actionLabel="Connect GitHub"
            onAction={() => navigation.navigate('GitHubConnection', { hostId: reads[0]!.hostId })}
          />
        ) : reads.every((host) => host.state.kind === 'error') ? undefined : (
          <EmptyState
            variant="plain"
            title={typed ? 'No results' : 'No matching pull requests'}
            detail={typed ? 'No pull request matches this search.' : 'Pull requests of the selected hosts’ projects appear here. Pull to refresh.'}
          />
        )
      }
      ListFooterComponent={
        <>
          {list.loadingMore ? (
            <View className="items-center py-5">
              <ActivityIndicator colorClassName="accent-icon" accessibilityLabel="Loading more pull requests" />
            </View>
          ) : null}
          {notShown.length > 0 ? (
            <View className="gap-1 px-5 pt-6">
              <Text accessibilityRole="header" className="pb-1 text-xs font-t3-medium tracking-[0.5px] uppercase text-foreground-muted">Not shown</Text>
              {notShown.map((entry) => (
                <Text key={entry.key} className="text-xs leading-snug text-foreground-tertiary">{entry.text}</Text>
              ))}
            </View>
          ) : null}
        </>
      }
    />
  )
}
