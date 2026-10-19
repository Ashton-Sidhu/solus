// Adapted from T3 Code apps/mobile/src/features/pull-requests/PullRequestRouteScreen.tsx (MIT, see UPSTREAM.md).
import { useFocusEffect } from '@react-navigation/native'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ActivityIndicator, Alert, FlatList, Platform, Pressable, RefreshControl, ScrollView, Share, StyleSheet, View, type ScrollViewProps } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useApp, useListened } from '../../app/app-context'
import { SymbolView } from '../../components/AppSymbol'
import { AppText as Text } from '../../components/AppText'
import { ControlPillMenu } from '../../components/ControlPillMenu'
import { EmptyState } from '../../components/EmptyState'
import { ErrorBanner } from '../../components/ErrorBanner'
import { SegmentedControl } from '../../components/SegmentedControl'
import { copyTextWithHaptic } from '../../lib/copyTextWithHaptic'
import { shareLink } from '../../lib/share-link'
import type { ScreenProps } from '../../navigation/routes'
import { CODE_FONT } from '../../theme/tokens'
import { NativeScrollViewMarker } from '../../native/NativeScrollViewMarker'
import { NativeHeaderToolbar, NativeStackScreenOptions } from '../../native/StackHeader'
import { HostStatusBanner } from '../hosts/HostStatusBanner'
import { prAge } from './lib/pr-presentation'
import { DEFAULT_ACTIVITY_FILTER, filterPullRequestActivity, type ActivityFilter } from './lib/pull-request-activity'
import { pullRequestTabOffset } from './lib/pull-request-file-filters'
import type { GuideDiffFocus } from './lib/pull-request-guide-tour'
import { pullRequestRepositoryKey } from './lib/pull-request-list'
import type { PullRequestRef } from './pull-request-directory'
import { shownValue } from './pull-request-reads'
import { usePullRequestHostFallback } from './use-pull-request-host-fallback'
import { PullRequestActionToolbar, ANDROID_PULL_REQUEST_TOOLBAR_HEIGHT } from './detail/PullRequestActionToolbar'
import { PullRequestActivityFilters, pullRequestActivityRows, type ActivityRow } from './detail/PullRequestActivity'
import { PullRequestGuideTab } from './detail/PullRequestGuide'
import { PullRequestOverview } from './detail/PullRequestOverview'
import { PullRequestStatusMenu } from './detail/PullRequestStatusRows'
import { PullRequestAvatar, PullRequestDiffStats } from './detail/pull-request-ui'
import type { PullRequestView } from './detail/pull-request-view'
import { usePullRequestView } from './detail/use-pull-request-view'
import { PullRequestMediaContext } from './detail/use-pull-request-media-url'

type Tab = 'overview' | 'guide' | 'activity'

type LinkedPullRequest = { readonly url: string; readonly number: number; readonly title: string }

/** The system share sheet for a pull request's link. A cancelled sheet is not an error. */
async function sharePullRequest(pr: LinkedPullRequest) {
  const result = await shareLink(Share, { url: pr.url, title: `#${pr.number} ${pr.title}` }, Platform.OS)
  if (result.kind === 'failed') Alert.alert('Could not share the link', result.message)
}

/** The iOS menu's link actions. An array, not a fragment: the native menu reads its children by type. */
function pullRequestLinkMenuActions(pr: LinkedPullRequest, openBrowser: (url: string) => void) {
  return [
    <NativeHeaderToolbar.MenuAction key="open" icon="arrow.up.right" onPress={() => openBrowser(pr.url)}>
      <NativeHeaderToolbar.Label>Open on GitHub</NativeHeaderToolbar.Label>
    </NativeHeaderToolbar.MenuAction>,
    <NativeHeaderToolbar.MenuAction key="copy" icon="doc.on.doc" onPress={() => copyTextWithHaptic(pr.url)}>
      <NativeHeaderToolbar.Label>Copy link</NativeHeaderToolbar.Label>
    </NativeHeaderToolbar.MenuAction>,
    <NativeHeaderToolbar.MenuAction key="share" icon="square.and.arrow.up" onPress={() => void sharePullRequest(pr)}>
      <NativeHeaderToolbar.Label>Share…</NativeHeaderToolbar.Label>
    </NativeHeaderToolbar.MenuAction>,
  ]
}

/**
 * iOS: register the tab's list with the native header so UIKit samples the
 * list's own surface for the scroll-edge material, and inset the content by
 * hand so the resting top sits under the bar.
 */
function PullRequestTabScrollView(props: ScrollViewProps) {
  const insets = useSafeAreaInsets()
  return (
    <NativeScrollViewMarker style={{ flex: 1 }}>
      <ScrollView
        {...props}
        automaticallyAdjustContentInsets={false}
        contentInsetAdjustmentBehavior="never"
        contentOffset={props.contentOffset ?? { x: 0, y: -insets.top }}
      />
    </NativeScrollViewMarker>
  )
}

/** FlatList calls this as a plain function, so the hooks live in the component it returns. */
function renderPullRequestTabScrollView(props: ScrollViewProps) {
  return <PullRequestTabScrollView {...props} />
}

/**
 * One pull request, as T3 Code's pull request screen: the pull request at the
 * top, then the tabs Overview, Guide, and Activity, and a toolbar with the
 * agent tasks, the main action, and the changed files. Every tab stays
 * mounted, so each keeps its own scroll position; while the shared header is
 * in view, a tab switch keeps it where it is. A file, a commit, or a guide
 * stop opens the diff on its own screen. Offline, the device copy shows with
 * a "not refreshed" line, and the writes say why they are off.
 */
export function PullRequestScreen({ navigation, route }: ScreenProps<'PullRequest'>) {
  const { hostId, projectPath, number } = route.params
  const ref = useMemo<PullRequestRef>(() => ({ hostId, projectPath, number }), [hostId, projectPath, number])
  const app = useApp()
  const insets = useSafeAreaInsets()
  const { state, view, connected, reload } = usePullRequestView(ref)
  const guideState = useListened(app.pullRequestGuides.changes, () => app.pullRequestGuides.guideOf(ref))
  const pr = view?.pr ?? null
  const permissions = view?.permissions ?? null
  // While this host is offline, another connected host with the repository reads the pull request.
  const moveToHost = useCallback((target: { hostId: string; projectPath: string }) => navigation.setParams(target), [navigation])
  usePullRequestHostFallback(ref, pr ? pullRequestRepositoryKey(pr) : null, moveToHost)
  useEffect(() => { void app.reviewDrafts.load(ref) }, [app, ref])

  // The guide follows its job while the screen is shown.
  const guidePr = useMemo(() => pr && { baseRepo: pr.baseRepo, number: pr.number, url: pr.url, baseSha: pr.baseSha, headSha: pr.headSha },
    // The guide target changes only with these facts of the pull request.
    [pr?.headSha, pr?.baseSha, pr?.number, pr?.url])
  useFocusEffect(useCallback(() => {
    if (!guidePr) return
    void app.pullRequestGuides.load(ref, guidePr)
    return app.pullRequestGuides.watch(ref, guidePr)
  }, [app, ref, guidePr]))
  // A host that can read guides answers the status read; a failed read with no device copy hides the tab.
  const guidesShown = shownValue(guideState) !== null

  const [tab, setTab] = useState<Tab>('overview')
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>(DEFAULT_ACTIVITY_FILTER)
  const lists = useRef<Partial<Record<Tab, FlatList<ActivityRow> | null>>>({})
  const offsets = useRef<Partial<Record<Tab, number>>>({})
  // On iOS the lists rest at -topInset: their content starts under the bar.
  const topInset = Platform.OS === 'ios' ? insets.top : 0
  const currentOffset = useRef(-topInset)
  const headerHeight = useRef(0)
  const shownTab: Tab = tab === 'guide' && !guidesShown ? 'overview' : tab
  // Rows keep these commands, so they read the tab shown now from a ref.
  const shownTabRef = useRef(shownTab)
  shownTabRef.current = shownTab

  const selectTab = useCallback((next: Tab) => {
    const shown = shownTabRef.current
    if (next === shown) return
    offsets.current[shown] = currentOffset.current
    const offset = pullRequestTabOffset(currentOffset.current, offsets.current[next], headerHeight.current - topInset)
    offsets.current[next] = offset
    currentOffset.current = offset
    lists.current[next]?.scrollToOffset({ offset, animated: false })
    shownTabRef.current = next
    setTab(next)
  }, [topInset])
  const openFile = useCallback((path: string, focus: GuideDiffFocus | null = null) => {
    navigation.navigate('PullRequestFiles', { ...ref, path, ...(focus ? { focus } : {}) })
  }, [navigation, ref])
  const openCommit = useCallback((sha: string) => navigation.navigate('PullRequestFiles', { ...ref, commitSha: sha }), [navigation, ref])
  const openThread = useCallback((threadId: string) => navigation.navigate('PullRequestDiscussion', { ...ref, threadId }), [navigation, ref])

  const canReview = Boolean(permissions?.verdicts.length)
  const canComment = Boolean(permissions?.canComment)
  // Android draws the actions in its header; iOS has the native menu below.
  useLayoutEffect(() => {
    const actions = [
      ...(canReview ? [{ id: 'review', title: 'Submit review', image: 'text.bubble' }] : []),
      ...(canComment ? [{ id: 'comment', title: 'Add comment', image: 'plus.bubble' }] : []),
      ...(pr ? [
        { id: 'open', title: 'Open on GitHub', image: 'arrow.up.right' },
        { id: 'copy', title: 'Copy link', image: 'doc.on.doc' },
        { id: 'share', title: 'Share…', image: 'square.and.arrow.up' },
      ] : []),
    ]
    navigation.setOptions({
      title: `#${number}`,
      headerRight: Platform.OS === 'android' && actions.length ? () => (
        <ControlPillMenu
          accessibilityLabel="Pull request actions"
          title="Pull request"
          actions={actions}
          onPressAction={({ nativeEvent }) => {
            if (nativeEvent.event === 'review' || nativeEvent.event === 'comment') navigation.navigate('PullRequestReview', { ...ref, mode: nativeEvent.event })
            else if (nativeEvent.event === 'open' && pr) void app.platform.openBrowser(pr.url)
            else if (nativeEvent.event === 'copy' && pr) copyTextWithHaptic(pr.url)
            else if (nativeEvent.event === 'share' && pr) void sharePullRequest(pr)
          }}
        >
          <Pressable accessibilityRole="button" accessibilityLabel="Pull request actions" hitSlop={8} className="h-9 w-9 items-center justify-center">
            <SymbolView name="ellipsis" size={18} tintColorClassName="accent-icon" type="monochrome" />
          </Pressable>
        </ControlPillMenu>
      ) : undefined,
    })
  }, [app, navigation, number, canReview, canComment, pr, ref])

  const activity = useMemo(() => {
    if (!view) return null
    return filterPullRequestActivity({ comments: view.detail.comments, threads: view.detail.threads, commits: view.detail.overview.commits }, activityFilter)
  }, [view, activityFilter])
  const rowsByTab = useMemo((): Record<Tab, ActivityRow[]> => {
    if (!view || !activity) return { overview: [], activity: [], guide: [] }
    const timeline = pullRequestActivityRows(activity.activity, activityFilter.newestFirst, { openThread, openCommit })
    const unread = (['comments', 'threads'] as const).filter((part) => view.detail.missing.includes(part))
    const reading = (['overview', 'comments', 'threads'] as const).some((part) => view.detail.reading?.includes(part))
    return {
      overview: [{ key: 'overview', date: '', content: <PullRequestOverview view={view} onOpenFile={openFile} /> }],
      activity: [
        { key: 'filters', date: '', content: <PullRequestActivityFilters value={activityFilter} onChange={setActivityFilter} hiddenCount={activity.hiddenCount} /> },
        ...(unread.length ? [{ key: 'unread', date: '', content: <Text className="pb-4 text-xs text-foreground-muted">Some of the conversation could not be read.</Text> }] : []),
        ...(reading ? [{ key: 'reading', date: '', content: <Text className="pb-4 text-xs text-foreground-muted">Reading the conversation…</Text> }] : []),
        ...(timeline.length || reading ? timeline : [{ key: 'empty', date: '', content: <Text className="py-6 text-sm text-foreground-muted">No activity matches these filters.</Text> }]),
      ],
      guide: [{ key: 'guide', date: '', content: <PullRequestGuideTab view={view} onOpenFile={openFile} /> }],
    }
  }, [view, activity, activityFilter, openThread, openFile, openCommit])

  const subtitle = pr ? `${pr.baseRepo.owner}/${pr.baseRepo.repo}${connected ? '' : ' · Offline'}` : connected ? undefined : 'Offline'
  const header = (
    <>
      {/* T3's header: the number, the repository under it, and the actions menu. */}
      <NativeStackScreenOptions options={{ unstable_headerSubtitle: subtitle }} />
      <NativeHeaderToolbar placement="right">
        <NativeHeaderToolbar.Menu title="Pull request" accessibilityLabel="Pull request actions" icon="ellipsis">
          {canReview ? (
            <NativeHeaderToolbar.MenuAction icon="text.bubble" onPress={() => navigation.navigate('PullRequestReview', { ...ref, mode: 'review' })}>
              <NativeHeaderToolbar.Label>Submit review</NativeHeaderToolbar.Label>
            </NativeHeaderToolbar.MenuAction>
          ) : null}
          {canComment ? (
            <NativeHeaderToolbar.MenuAction icon="plus.bubble" onPress={() => navigation.navigate('PullRequestReview', { ...ref, mode: 'comment' })}>
              <NativeHeaderToolbar.Label>Add comment</NativeHeaderToolbar.Label>
            </NativeHeaderToolbar.MenuAction>
          ) : null}
          {pr ? pullRequestLinkMenuActions(pr, (url) => void app.platform.openBrowser(url)) : null}
        </NativeHeaderToolbar.Menu>
      </NativeHeaderToolbar>
    </>
  )

  if (!view) {
    return (
      <View className="flex-1 bg-screen" style={{ paddingTop: topInset }}>
        {header}
        <HostStatusBanner hostId={hostId} />
        {state.kind === 'error' ? (
          <View className="px-5 pt-4">
            {state.githubAuth ? (
              <EmptyState title="Connect GitHub to read this pull request" detail="The host reads pull requests with its own GitHub connection." actionLabel="Connect GitHub" onAction={() => navigation.navigate('GitHubConnection', { hostId })} />
            ) : (
              <EmptyState title="Pull request unavailable" detail={state.offline ? 'This pull request was not read on this device before, and the host cannot be reached now.' : state.message} actionLabel="Try again" onAction={reload} />
            )}
          </View>
        ) : (
          <View className="items-center py-16">
            <ActivityIndicator colorClassName="accent-icon" />
            <Text className="mt-3 text-sm text-foreground-muted">Loading pull request…</Text>
          </View>
        )}
      </View>
    )
  }

  const tabs = [
    { value: 'overview' as const, label: 'Overview' },
    ...(guidesShown ? [{ value: 'guide' as const, label: 'Guide' }] : []),
    { value: 'activity' as const, label: 'Activity' },
  ]
  const bottomPadding = Platform.OS === 'android' ? insets.bottom + ANDROID_PULL_REQUEST_TOOLBAR_HEIGHT + 24 : 24

  return (
    <PullRequestMediaContext.Provider value={ref}>
      <View className="flex-1 bg-screen">
        {header}
        {(['overview', 'guide', 'activity'] as const).filter((entry) => entry !== 'guide' || guidesShown).map((entry) => (
          <TabPane key={entry} shown={shownTab === entry}>
            <FlatList
              ref={(list) => { lists.current[entry] = list }}
              data={rowsByTab[entry]}
              keyExtractor={(row) => row.key}
              renderItem={({ item }) => <View>{item.content}</View>}
              renderScrollComponent={Platform.OS === 'ios' ? renderPullRequestTabScrollView : undefined}
              contentInsetAdjustmentBehavior="never"
              contentInset={Platform.OS === 'ios' ? { top: insets.top, bottom: insets.bottom } : undefined}
              scrollIndicatorInsets={Platform.OS === 'ios' ? { top: insets.top, bottom: insets.bottom } : undefined}
              keyboardShouldPersistTaps="handled"
              alwaysBounceVertical
              scrollsToTop={shownTab === entry}
              onScroll={(event) => {
                const offset = event.nativeEvent.contentOffset.y
                offsets.current[entry] = offset
                if (shownTabRef.current === entry) currentOffset.current = offset
              }}
              scrollEventThrottle={32}
              refreshControl={<RefreshControl refreshing={shownTab === entry && state.kind === 'loading'} onRefresh={reload} />}
              contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: bottomPadding }}
              ListHeaderComponent={
                <View className="gap-5 pb-5" onLayout={(event) => { headerHeight.current = event.nativeEvent.layout.height }}>
                  <HostStatusBanner hostId={hostId} />
                  {state.kind === 'error' ? <ErrorBanner message={`Not refreshed: ${state.message}`} /> : null}
                  {!connected ? <Text className="text-xs text-foreground-muted">This is the copy on this device. Reviews, merges, and agent work need the host to be connected.</Text> : null}
                  <PullRequestIdentity view={view} />
                  <SegmentedControl options={tabs} selected={shownTab} onSelect={selectTab} role="tab" size="compact" />
                </View>
              }
            />
          </TabPane>
        ))}
        <PullRequestActionToolbar view={view} />
      </View>
    </PullRequestMediaContext.Provider>
  )
}

/** A hidden tab stays mounted, so its scroll position and measured rows stay. */
function TabPane(props: { readonly shown: boolean; readonly children: ReactNode }) {
  return (
    <View
      style={[StyleSheet.absoluteFill, { opacity: props.shown ? 1 : 0 }]}
      pointerEvents={props.shown ? 'auto' : 'none'}
      accessibilityElementsHidden={!props.shown}
      importantForAccessibility={props.shown ? 'auto' : 'no-hide-descendants'}
    >
      {props.children}
    </View>
  )
}

function PullRequestIdentity({ view }: { readonly view: PullRequestView }) {
  const { pr } = view
  return (
    <View className="gap-3">
      <View className="flex-row flex-wrap items-center gap-2">
        <PullRequestStatusMenu view={view} />
        <PullRequestDiffStats additions={pr.additions} deletions={pr.deletions} compact />
        {pr.changedFiles !== null ? <Text className="text-2xs text-foreground-muted">{pr.changedFiles} {pr.changedFiles === 1 ? 'file' : 'files'}</Text> : null}
      </View>
      <Text selectable accessibilityRole="header" className="text-xl font-t3-bold leading-7">{pr.title}</Text>
      <View className="flex-row items-center gap-2">
        <PullRequestAvatar login={pr.author} avatarUrl={pr.authorAvatarUrl} size={20} />
        <Text className="min-w-0 flex-1 text-xs font-t3-medium" numberOfLines={1}>{pr.author}</Text>
        <Text className="shrink text-right text-2xs text-foreground-muted" numberOfLines={1}>Updated {prAge(pr.updatedAt, Date.now())}</Text>
      </View>
      <View className="flex-row items-start gap-1.5">
        <Pressable accessibilityRole="button" accessibilityLabel={`Copy base branch ${pr.baseRef}`} onPress={() => copyTextWithHaptic(pr.baseRef)} className="min-w-0 shrink active:opacity-70" hitSlop={8}>
          <Text className="text-2xs text-foreground-muted" style={{ fontFamily: CODE_FONT }}>{pr.baseRef}</Text>
        </Pressable>
        <View className="pt-0.5"><SymbolView name="arrow.left" size={11} tintColorClassName="accent-icon-muted" /></View>
        <Pressable accessibilityRole="button" accessibilityLabel={`Copy head branch ${pr.headRef}`} onPress={() => copyTextWithHaptic(pr.headRef)} className="min-w-0 shrink active:opacity-70" hitSlop={8}>
          <Text className="text-2xs text-foreground-muted" style={{ fontFamily: CODE_FONT }}>{pr.headRef}</Text>
        </Pressable>
      </View>
    </View>
  )
}
