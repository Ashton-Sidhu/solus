// Adapted from T3 Code apps/mobile/src/features/pull-requests/PullRequestRouteScreen.tsx (PullRequestFileRouteScreen) and PullRequestFiles.tsx (MIT, see UPSTREAM.md).
import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useApp, useListened } from '../../../app/app-context'
import { SymbolView } from '../../../components/AppSymbol'
import { AppText as Text } from '../../../components/AppText'
import { ControlPillMenu } from '../../../components/ControlPillMenu'
import { EmptyState } from '../../../components/EmptyState'
import { MaterialButton } from '../../../components/MaterialButton'
import type { RootStackParamList } from '../../../navigation/routes'
import { CODE_FONT } from '../../../theme/tokens'
import { isNativeReviewDiffDrawEvent, parseNativeReviewDiffDebugEvent, resolveNativeReviewDiffView, type NativeReviewDiffViewHandle, type NativeReviewDiffViewProps } from '../../diffs/nativeReviewDiffSurface'
import { buildNativeReviewDiffData, NATIVE_REVIEW_DIFF_CONTENT_WIDTH } from '../../review/nativeReviewDiffAdapter'
import { getSelectedReviewCommentLines, type ReviewCommentTarget } from '../../review/reviewCommentSelection'
import { buildReviewParsedDiff, type ReviewParsedDiff } from '../../review/reviewModel'
import { useNativeReviewDiffBridge } from '../../review/useNativeReviewDiffBridge'
import { useReviewCommentSelectionController } from '../../review/useReviewCommentSelectionController'
import { useAppearanceCodeSurface } from '../../settings/appearance/useAppearanceCodeSurface'
import { useAppearancePreferences } from '../../settings/appearance/AppearancePreferencesProvider'
import { annotatePullRequestDiff, draftAnchor } from '../lib/pull-request-diff-comments'
import { diffIsTruncated, pullRequestDiffPatch, type PullRequestDiffPage } from '../lib/pull-request-diff-pages'
import { filterPullRequestTestFiles, hiddenTestFileCount, pullRequestFilesSummary } from '../lib/pull-request-file-filters'
import { guideFocusedRows, type GuideDiffFocus } from '../lib/pull-request-guide-tour'
import { currentReviewComments } from '../lib/pull-request-review-draft'
import type { PullRequestDiffRef } from '../pull-request-diffs'
import { shownValue } from '../pull-request-reads'
import { PullRequestDiffStats, PullRequestReadStatus } from './pull-request-ui'
import { usePullRequestFilesViewed } from './use-pull-request-files-viewed'
import type { PullRequestView } from './pull-request-view'

type Navigation = NativeStackNavigationProp<RootStackParamList>

const EMPTY_IDS: readonly string[] = []

/** A request to show one file, from the overview, a commit, or a guide excerpt. */
export interface FilesJump {
  readonly path: string
  readonly focus: GuideDiffFocus | null
  /** Each request is new, also for the same file again. */
  readonly id: number
}

/**
 * The Files tab: the whole pull request, or one commit, on the native diff
 * surface. Files can be hidden (tests), collapsed, and marked viewed. A tap
 * on a line writes a review comment on it; a long press starts a range.
 * Review threads and draft comments show under their lines.
 */
export function PullRequestFiles(props: {
  readonly view: PullRequestView
  readonly active: boolean
  readonly commitSha: string | null
  readonly onShowAllChanges: () => void
  readonly jump: FilesJump | null
}) {
  const { view, commitSha, jump } = props
  const app = useApp()
  const navigation = useNavigation<Navigation>()
  const insets = useSafeAreaInsets()
  const { pr, permissions } = view
  const diffRef = useMemo<PullRequestDiffRef>(() => (commitSha ? { ...view.ref, commitSha } : view.ref), [view.ref, commitSha])
  const state = useListened(app.pullRequestDiffs.changes, () => app.pullRequestDiffs.diffOf(diffRef))
  const canLoadMore = useListened(app.pullRequestDiffs.changes, () => app.pullRequestDiffs.canLoadMore(diffRef))
  const diff = shownValue(state)
  const load = useCallback(() => { void app.pullRequestDiffs.load(diffRef, { baseSha: pr.baseSha, headSha: pr.headSha }) }, [app, diffRef, pr.baseSha, pr.headSha])
  const loadMore = useCallback(() => {
    if (app.pullRequestDiffs.canLoadMore(diffRef) && app.pullRequestDiffs.diffOf(diffRef).kind === 'loaded') void app.pullRequestDiffs.loadMore(diffRef)
  }, [app, diffRef])
  useEffect(() => {
    if (props.active && state.kind === 'idle') load()
  }, [props.active, state.kind, load])

  const stale = !commitSha && diff !== null && diff.revision.headSha !== pr.headSha
  const patch = useMemo(() => (diff ? pullRequestDiffPatch(diff.pages) : ''), [diff])
  const parsed = useMemo(() => buildReviewParsedDiff(patch, `pr:${view.ref.hostId}:${view.ref.projectPath}:${view.ref.number}:${commitSha ?? 'all'}`), [patch, view.ref, commitSha])
  const [hideTests, setHideTests] = useState(false)
  const visible = useMemo(() => filterPullRequestTestFiles(parsed, hideTests, jump?.path), [parsed, hideTests, jump?.path])
  const hiddenCount = hiddenTestFileCount(parsed, visible)
  const draft = useListened(app.reviewDrafts.changes, () => app.reviewDrafts.draftOf(view.ref))
  const baseData = useMemo(() => buildNativeReviewDiffData(visible), [visible])
  const data = useMemo(() => annotatePullRequestDiff(
    baseData,
    commitSha || stale ? [] : view.detail.threads,
    commitSha ? [] : currentReviewComments(draft, diff?.revision.headSha ?? ''),
    diff?.revision.headSha,
  ), [baseData, commitSha, stale, view.detail.threads, draft, diff?.revision.headSha])
  const viewed = usePullRequestFilesViewed(view, commitSha)
  const viewedIds = data.files.filter((file) => viewed.isViewed(file.path)).map((file) => file.id)
  const [collapsedIds, setCollapsedIds] = useState<readonly string[]>(EMPTY_IDS)

  const canComment = permissions.canInlineComment && !commitSha && !stale && state.kind === 'loaded'
  const openComment = useCallback((target: ReviewCommentTarget) => {
    const lines = getSelectedReviewCommentLines(target)
    const anchor = draftAnchor(lines)
    if (!anchor || !diff) return
    navigation.navigate('PullRequestInlineComment', {
      ...view.ref,
      path: target.filePath,
      ...anchor,
      headSha: diff.revision.headSha,
      code: lines.map((line) => line.content).join('\n'),
    })
  }, [diff, navigation, view.ref])
  const section = useMemo(() => ({ id: `pr:${view.ref.hostId}:${view.ref.projectPath}:${view.ref.number}:${commitSha ?? 'all'}`, title: `#${view.ref.number}` }), [view.ref, commitSha])
  const selection = useReviewCommentSelectionController({ section, nativeReviewDiffData: data, onOpenComment: openComment })

  const targetFile = jump ? data.files.find((file) => file.path === jump.path) : undefined
  const focusedRows = guideFocusedRows(data.rows, targetFile?.id, jump?.focus)
  const { nativeReviewDiffStyle } = useAppearanceCodeSurface()
  const { themeAppearance } = useAppearancePreferences()
  const bridge = useNativeReviewDiffBridge({
    threadKey: null,
    sectionId: section.id,
    diff: patch,
    data,
    collapsedFileIds: collapsedIds,
    viewedFileIds: viewedIds,
    selectedRowIds: selection.selectedRowIds.length ? selection.selectedRowIds : focusedRows.map((row) => row.id),
    canHighlight: true,
  })
  const [NativeDiffView] = useState(() => resolveNativeReviewDiffView())
  const nativeView = useRef<NativeReviewDiffViewHandle>(null)
  const jumped = useRef<number | null>(null)

  // A file of a later page is read before the view can jump to it.
  useEffect(() => {
    if (!jump || jumped.current === jump.id) return
    if (!targetFile) {
      if (canLoadMore) loadMore()
      return
    }
    if (!nativeView.current) return
    jumped.current = jump.id
    setCollapsedIds((ids) => ids.filter((id) => id !== targetFile.id))
    nativeView.current.scrollToFile(targetFile.id, false).catch(() => { jumped.current = null })
  }, [jump, targetFile, canLoadMore, loadMore])

  const { onDebug: updateVisibleRange } = bridge
  const onDebug = useCallback<NonNullable<NativeReviewDiffViewProps['onDebug']>>((event) => {
    const payload = parseNativeReviewDiffDebugEvent(event.nativeEvent)
    // An event for an earlier row payload must not jump or load.
    if (payload.totalRows !== undefined && payload.totalRows !== data.rows.length) return
    if (!isNativeReviewDiffDrawEvent(payload) && payload.message !== 'rows-decoded') return
    if (isNativeReviewDiffDrawEvent(payload)) updateVisibleRange(event)
    if (jump && targetFile && jumped.current !== jump.id && nativeView.current) {
      jumped.current = jump.id
      nativeView.current.scrollToFile(targetFile.id, false).catch(() => { jumped.current = null })
      return
    }
    if (payload.lastRowIndex !== undefined && payload.lastRowIndex >= data.rows.length - 40) loadMore()
  }, [updateVisibleRange, data.rows.length, loadMore, jump, targetFile])

  const onToggleViewedFile = useCallback<NonNullable<NativeReviewDiffViewProps['onToggleViewedFile']>>((event) => {
    const file = data.files.find((entry) => entry.id === event.nativeEvent.fileId)
    if (!file) return
    const wasViewed = viewed.isViewed(file.path)
    if (!viewed.toggle(file.path)) return
    // A file marked viewed folds away; a file marked unviewed opens again.
    setCollapsedIds((ids) => wasViewed ? ids.filter((id) => id !== file.id) : ids.includes(file.id) ? ids : [...ids, file.id])
  }, [data.files, viewed])

  const onToggleComment = useCallback<NonNullable<NativeReviewDiffViewProps['onToggleComment']>>((event) => {
    const id = event.nativeEvent.commentId ?? ''
    if (id.startsWith('discussion:')) navigation.navigate('PullRequestDiscussion', { ...view.ref, threadId: id.slice('discussion:'.length) })
    if (id.startsWith('draft:')) {
      const comment = draft.comments.find((entry) => entry.id === id.slice('draft:'.length))
      if (!comment) return
      const params: RootStackParamList['PullRequestInlineComment'] = { ...view.ref, path: comment.path, side: comment.side, line: comment.line, headSha: comment.headSha, code: '', draftId: comment.id }
      if (comment.startLine !== undefined) params.startLine = comment.startLine
      navigation.navigate('PullRequestInlineComment', params)
    }
  }, [draft.comments, navigation, view.ref])

  const error = state.kind === 'error' ? state.message : null
  const summary = pullRequestFilesSummary({
    commitSha,
    visible,
    hiddenCount,
    viewedCount: viewedIds.length,
  })
  const pressLineProps: PressLineProps = {}
  if (canComment) pressLineProps.onPressLine = selection.onPressLine
  const diffView = NativeDiffView ? (
    <NativeDiffView
      nativeViewRef={nativeView}
      style={StyleSheet.absoluteFill}
      refreshing={state.kind === 'loading'}
      onPullToRefresh={load}
      rowsJson={bridge.rowsJson}
      themeJson={bridge.themeJson}
      styleJson={bridge.styleJson}
      tokensPatchJson={bridge.tokensPatchJson}
      tokensResetKey={bridge.tokensResetKey}
      collapsedFileIdsJson={bridge.collapsedFileIdsJson}
      viewedFileIdsJson={bridge.viewedFileIdsJson}
      selectedRowIdsJson={bridge.selectedRowIdsJson}
      collapsedCommentIdsJson={bridge.collapsedCommentIdsJson}
      onDebug={onDebug}
      {...pressLineProps}
      onToggleFile={(event) => {
        const id = event.nativeEvent.fileId
        if (id) setCollapsedIds((ids) => ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id])
      }}
      onToggleViewedFile={onToggleViewedFile}
      onToggleComment={onToggleComment}
      appearanceScheme={themeAppearance}
      rowHeight={nativeReviewDiffStyle.rowHeight}
      contentWidth={NATIVE_REVIEW_DIFF_CONTENT_WIDTH}
      contentInsetBottom={insets.bottom}
      contentResetKey={section.id}
    />
  ) : null

  return (
    <View className="flex-1">
      <FilesHeader
        summary={summary}
        isCommit={commitSha !== null}
        onShowAllChanges={props.onShowAllChanges}
        visible={visible}
        hideTests={hideTests}
        onToggleHideTests={() => setHideTests(!hideTests)}
      />
      {stale ? (
        <View className="flex-row items-center gap-2 px-4 pb-2">
          <Text className="min-w-0 flex-1 text-xs text-foreground-muted">The branch changed. Load the new changes before you comment on lines.</Text>
          <MaterialButton label="Reload" onPress={load} />
        </View>
      ) : null}
      <ViewedNotes note={viewed.note} dismissed={viewed.dismissed} />
      {selection.selectionAction ? <SelectionBar action={selection.selectionAction} onCancel={selection.clearSelection} /> : null}
      <FilesBody
        isLoading={state.kind === 'loading'}
        hasDiff={diff !== null}
        error={error}
        onRetry={load}
        hasNativeView={NativeDiffView !== null}
        visible={visible}
        detailFiles={view.detail.files}
        rowCount={data.rows.length}
        diffView={diffView}
        hiddenCount={hiddenCount}
        onShowTests={() => setHideTests(false)}
        canLoadMore={canLoadMore}
        bottomInset={insets.bottom}
      />
      <FilesFooter
        error={error}
        pages={diff?.pages ?? null}
        onRetry={canLoadMore ? loadMore : load}
        parsed={parsed}
      />
    </View>
  )
}

/** The diff surface takes `onPressLine` only when the person can comment on lines. */
interface PressLineProps {
  onPressLine?: NativeReviewDiffViewProps['onPressLine']
}

/** The summary, the stats of the visible files, and the menu that hides test files. */
function FilesHeader(props: {
  readonly summary: string
  readonly isCommit: boolean
  readonly onShowAllChanges: () => void
  readonly visible: ReviewParsedDiff
  readonly hideTests: boolean
  readonly onToggleHideTests: () => void
}) {
  const { visible, hideTests } = props
  return (
    <View className="flex-row items-center gap-2 px-4 py-2">
      <View className="min-w-0 flex-1">
        <Text className="text-2xs text-foreground-muted" numberOfLines={1}>{props.summary}</Text>
        {props.isCommit ? (
          <Pressable accessibilityRole="button" onPress={props.onShowAllChanges} hitSlop={8} className="active:opacity-60">
            <Text className="text-xs font-t3-medium text-primary-text">Show all changes</Text>
          </Pressable>
        ) : null}
      </View>
      {visible.kind === 'files' ? <PullRequestDiffStats additions={visible.additions} deletions={visible.deletions} compact /> : null}
      <ControlPillMenu
        title="Files"
        actions={[{ id: 'hide-tests', title: 'Hide test files', image: 'line.3.horizontal.decrease', state: hideTests ? 'on' : 'off' }]}
        onPressAction={props.onToggleHideTests}
      >
        <Pressable accessibilityRole="button" accessibilityLabel="Filter files" className="size-11 items-center justify-center active:opacity-60">
          <SymbolView name={hideTests ? 'line.3.horizontal.decrease.circle.fill' : 'line.3.horizontal.decrease'} size={18} tintColorClassName="accent-icon-muted" />
        </Pressable>
      </ControlPillMenu>
    </View>
  )
}

/** A line selection in progress. `onOpenComment` is null until the range has its last line. */
interface SelectionAction {
  readonly title: string
  readonly onOpenComment: (() => void) | null
}

/** The bar of a line selection in progress: write the comment, or cancel. */
function SelectionBar({ action, onCancel }: { readonly action: SelectionAction; readonly onCancel: () => void }) {
  return (
    <View className="flex-row items-center gap-2 px-4 pb-2">
      <Text className="min-w-0 flex-1 text-xs text-foreground-muted">{action.onOpenComment ? 'Lines selected.' : 'Tap the last line of the range.'}</Text>
      {action.onOpenComment ? <MaterialButton label={action.title} tone="primary" onPress={action.onOpenComment} /> : null}
      <MaterialButton label="Cancel" tone="text" onPress={onCancel} />
    </View>
  )
}

/** Why the viewed marks cannot change now, and the files that changed since they were viewed. */
function ViewedNotes({ note, dismissed }: { readonly note: string | null; readonly dismissed: readonly string[] }) {
  if (!note && dismissed.length === 0) return null
  const names = dismissed.slice(0, 3).map((path) => path.slice(path.lastIndexOf('/') + 1)).join(', ')
  const more = dismissed.length > 3 ? ` and ${dismissed.length - 3} more` : ''
  return (
    <View className="gap-1 px-4 pb-2">
      {dismissed.length ? <Text className="text-xs text-warning-foreground">Changed since viewed: {names}{more}</Text> : null}
      {note ? <Text className="text-xs text-foreground-muted">{note}</Text> : null}
    </View>
  )
}

/** The notes under the diff: a failed refresh, contents GitHub left out, and a parser notice. */
function FilesFooter(props: {
  readonly error: string | null
  readonly pages: readonly PullRequestDiffPage[] | null
  readonly onRetry: () => void
  readonly parsed: ReviewParsedDiff
}) {
  const { error, pages, parsed } = props
  return (
    <>
      {error && pages ? (
        <Pressable accessibilityRole="button" onPress={props.onRetry} className="min-h-11 items-center justify-center px-4 py-2">
          <Text className="text-xs text-foreground-muted">{`Not refreshed: ${error}`}</Text>
        </Pressable>
      ) : null}
      {pages && diffIsTruncated(pages) ? <Text className="px-4 py-2 text-2xs text-foreground-muted">GitHub left out some file contents. Open the pull request on GitHub to see them.</Text> : null}
      {parsed.kind === 'files' && parsed.notice ? <Text className="px-4 py-2 text-2xs text-foreground-muted">{parsed.notice}</Text> : null}
    </>
  )
}

/**
 * The diff, or what shows in its place: the read status, the fallback for an
 * old app build, or an empty state. A bar shows while more files load.
 */
function FilesBody(props: {
  readonly isLoading: boolean
  readonly hasDiff: boolean
  readonly error: string | null
  readonly onRetry: () => void
  readonly hasNativeView: boolean
  readonly visible: ReviewParsedDiff
  readonly detailFiles: readonly DiffFileStats[]
  readonly rowCount: number
  readonly diffView: ReactNode
  readonly hiddenCount: number
  readonly onShowTests: () => void
  readonly canLoadMore: boolean
  readonly bottomInset: number
}) {
  const { isLoading, hasDiff, error, hasNativeView, visible } = props
  return (
    <View className="flex-1" collapsable={false}>
      {isLoading && !hasDiff ? <PullRequestReadStatus pending error={null} /> : null}
      {error && !hasDiff ? <PullRequestReadStatus pending={false} error={error} onRetry={props.onRetry} /> : null}
      {!hasNativeView && visible.kind === 'files' ? (
        <NeedsNewBuild paths={visible.files.map((file) => ({ path: file.path, additions: file.additions, deletions: file.deletions }))} />
      ) : !hasNativeView && hasDiff ? (
        <NeedsNewBuild paths={props.detailFiles} />
      ) : hasNativeView && props.rowCount > 0 ? (
        props.diffView
      ) : hasDiff && props.hiddenCount > 0 ? (
        <EmptyState title="Only test files changed" detail="Test files are hidden from this review." variant="plain" action={<MaterialButton label="Show test files" tone="primary" onPress={props.onShowTests} />} />
      ) : hasDiff && !isLoading ? (
        <EmptyState title="No text changes" detail="This diff has no text changes to show. Open the pull request on GitHub to see the rest." variant="plain" />
      ) : null}
      {isLoading && hasDiff && props.canLoadMore ? (
        <View className="absolute inset-x-0 bottom-0 flex-row items-center justify-center gap-2 bg-screen py-2" style={{ paddingBottom: props.bottomInset + 8 }}>
          <ActivityIndicator size="small" />
          <Text className="text-xs text-foreground-muted">Loading more files…</Text>
        </View>
      ) : null}
    </View>
  )
}

/** The path and line counts of one changed file. */
interface DiffFileStats {
  readonly path: string
  readonly additions: number
  readonly deletions: number
}

/** The fallback for an app build without the diff surface: the file list, and why. */
function NeedsNewBuild({ paths }: { readonly paths: readonly DiffFileStats[] }) {
  return (
    <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }}>
      <EmptyState title="This diff view needs a new app build" detail="Install the latest build of Solus to read the changes here. The changed files are below." variant="plain" />
      {paths.map((file) => (
        <View key={file.path} className="min-h-12 flex-row items-center gap-3 border-b border-border-subtle py-2.5">
          <Text className="min-w-0 flex-1 text-xs" style={{ fontFamily: CODE_FONT }} numberOfLines={2} ellipsizeMode="head">{file.path}</Text>
          <PullRequestDiffStats additions={file.additions} deletions={file.deletions} compact />
        </View>
      ))}
    </ScrollView>
  )
}
