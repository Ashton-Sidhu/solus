// Adapted from T3 Code apps/mobile/src/features/threads/git/GitOverviewSheet.tsx (MIT, see UPSTREAM.md).
import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import { ActionSheetIOS, ActivityIndicator, Alert, Linking, Platform, RefreshControl, ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { PrCommentActivityItem, PullRequest } from '@solus/contracts/providers'
import { useApp, useListened } from '../../app/app-context'
import { AppText as Text } from '../../components/AppText'
import { EmptyState } from '../../components/EmptyState'
import { ErrorBanner } from '../../components/ErrorBanner'
import { resolveMarkdownLinkPresentation } from '@t3tools/mobile-markdown-text/links'
import { useNativeMarkdownTextStyle } from '../../lib/nativeMarkdownTextStyle'
import type { ScreenProps } from '../../navigation/routes'
import { SelectableMarkdownText } from '../../native/SelectableMarkdownText'
import { CODE_FONT } from '../../theme/tokens'
import { HostStatusBanner } from '../hosts/HostStatusBanner'
import { PrComposerSheet, type PrComposerIntent } from './components/PrComposerSheet'
import { PrStateBadge } from './components/PrStateBadge'
import { MetaCard, SheetCard, SheetListRow, SheetRowDivider, SheetSectionLabel, SheetValueRow } from './components/pr-sheet'
import { canGiveVerdict, checkItemLabel, checksLabel, prAge, reviewerStateLabel, reviewStatusLabel, type CheckStatus } from './lib/pr-presentation'
import { shownValue, type PullRequestDetail, type PullRequestRef } from './pull-request-directory'

const CHECK_TONE_TEXT = {
  passing: 'text-adaptive-emerald-600-400',
  failing: 'text-adaptive-rose-600-400',
  pending: 'text-adaptive-amber-700-400',
  neutral: 'text-foreground-muted',
} as const satisfies Record<CheckStatus['tone'], string>

/**
 * One pull request as T3 Code's git sheet: actions in a card, what it changes
 * in meta cards, then checks, reviewers, files, and the conversation. The
 * phone comments, approves, or requests changes; merging and the diff stay
 * on the computer for now (apps/mobile/README.md).
 */
export function PullRequestScreen({ navigation, route }: ScreenProps<'PullRequest'>) {
  const ref: PullRequestRef = route.params
  const { hostId, projectPath, number } = ref
  const app = useApp()
  const insets = useSafeAreaInsets()
  const state = useListened(app.pullRequests.changes, () => app.pullRequests.detailOf({ hostId, projectPath, number }))
  const viewerLogin = useListened(app.pullRequests.changes, () => shownValue(app.pullRequests.hostOf(hostId))?.viewerLogin ?? null)
  const phase = useListened(app.connections.changes, () => app.connections.state(hostId)?.phase)
  const [intent, setIntent] = useState<PrComposerIntent | null>(null)
  const reload = useCallback(() => { void app.pullRequests.loadDetail({ hostId, projectPath, number }) }, [app, hostId, projectPath, number])

  useLayoutEffect(() => {
    navigation.setOptions({ title: `#${number}` })
  }, [navigation, number])

  useEffect(() => {
    if (phase === 'connected') reload()
  }, [phase, reload])

  useFocusEffect(reload)

  const detail = shownValue(state)
  if (!detail) {
    return (
      <View className="flex-1 bg-sheet">
        <HostStatusBanner hostId={hostId} />
        {state.kind === 'error' ? (
          <View className="px-5 pt-4">
            {state.githubAuth ? (
              <EmptyState
                title="Connect GitHub to read this pull request"
                detail="The host reads pull requests with its own GitHub connection."
                actionLabel="Connect GitHub"
                onAction={() => navigation.navigate('GitHubConnection', { hostId })}
              />
            ) : (
              <EmptyState title="Pull request unavailable" detail={state.message} actionLabel="Try again" onAction={reload} />
            )}
          </View>
        ) : (
          <View className="items-center py-16">
            <ActivityIndicator colorClassName="accent-icon" />
            <Text className="mt-3 text-sm text-foreground-muted">Loading pull request...</Text>
          </View>
        )}
      </View>
    )
  }

  const pr = detail.overview.pullRequest
  const submit = async (next: PrComposerIntent, body: string) => {
    if (next.kind === 'comment') await app.pullRequests.comment(ref, body)
    else await app.pullRequests.review(ref, next.verdict, body, pr.headSha)
  }
  const reviewVerdicts = (['approve', 'request-changes'] as const).filter((verdict) => canGiveVerdict(pr, verdict, viewerLogin))
  const chooseReview = () => {
    const labels = reviewVerdicts.map((verdict) => (verdict === 'approve' ? 'Approve' : 'Request changes'))
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions({ title: 'Review', options: [...labels, 'Cancel'], cancelButtonIndex: labels.length }, (index) => {
        const verdict = reviewVerdicts[index]
        if (verdict) setIntent({ kind: 'review', verdict })
      })
      return
    }
    Alert.alert('Review', undefined, [
      ...reviewVerdicts.map((verdict, index) => ({ text: labels[index]!, onPress: () => setIntent({ kind: 'review', verdict }) })),
      { text: 'Cancel', style: 'cancel' as const },
    ])
  }
  const review = reviewStatusLabel(pr.reviewStatus)
  const comments = detail.comments.filter((item): item is PrCommentActivityItem => item.kind !== 'label')

  return (
    <>
      <ScrollView
        alwaysBounceVertical
        className="flex-1 android:bg-sheet-solid ios:bg-screen"
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingHorizontal: Platform.OS === 'android' ? 8 : 20,
          paddingTop: 8,
          paddingBottom: Math.max(insets.bottom, 18) + 18,
          gap: Platform.OS === 'android' ? 8 : 14,
        }}
        refreshControl={<RefreshControl refreshing={state.kind === 'loading'} onRefresh={reload} />}
      >
        <HostStatusBanner hostId={hostId} />
        {state.kind === 'error' ? <ErrorBanner message={`Not refreshed: ${state.message}`} /> : null}
        <PrHeader pr={pr} />

        <SheetCard>
          <SheetListRow
            icon="safari"
            title="Open on GitHub"
            subtitle={`${pr.headRef} → ${pr.baseRef}`}
            onPress={() => void app.platform.openBrowser(pr.url)}
          />
          {pr.viewerPermissions.comment ? (
            <>
              <SheetRowDivider />
              <SheetListRow icon="text.bubble" title="Comment" subtitle="Reply on the pull request as a whole" onPress={() => setIntent({ kind: 'comment' })} />
            </>
          ) : null}
          {reviewVerdicts.length > 0 ? (
            <>
              <SheetRowDivider />
              <SheetListRow icon="checkmark.circle" title="Review" subtitle={reviewVerdicts.length > 1 ? 'Approve or request changes' : 'Approve'} onPress={chooseReview} />
            </>
          ) : null}
        </SheetCard>

        <View className="flex-row gap-2">
          <View className="flex-1"><MetaCard label="Changes" value={`+${pr.additions} −${pr.deletions}`} mono /></View>
          <View className="flex-1"><MetaCard label="Updated" value={prAge(pr.updatedAt, Date.now())} /></View>
        </View>
        {review ? <MetaCard label="Review" value={review} /> : null}
        <MetaCard label="Branch" value={pr.headRef} mono />

        <View className="gap-2">
          <SheetSectionLabel>Description</SheetSectionLabel>
          <SheetCard className="ios:py-3 android:px-4 android:py-3">
            {pr.body.trim() ? <PrMarkdown markdown={pr.body} /> : <Text className="text-sm text-foreground-muted">No description.</Text>}
          </SheetCard>
        </View>

        <ChecksSection detail={detail} pr={pr} onOpen={(url) => void app.platform.openBrowser(url)} />

        {detail.overview.reviewers.length > 0 ? (
          <View className="gap-2">
            <SheetSectionLabel>Reviewers</SheetSectionLabel>
            <SheetCard>
              {detail.overview.reviewers.map((reviewer, index) => (
                <View key={reviewer.login}>
                  {index > 0 ? <SheetRowDivider inset={false} /> : null}
                  <SheetValueRow label={reviewer.login} value={reviewerStateLabel(reviewer.state)} />
                </View>
              ))}
            </SheetCard>
          </View>
        ) : null}

        <View className="gap-2">
          <SheetSectionLabel>{`Files · ${detail.files.length}`}</SheetSectionLabel>
          <SheetCard>
            {detail.files.length === 0 ? <SheetValueRow label="Files" value={detail.missing.includes('files') ? 'Unavailable' : 'None'} /> : null}
            {detail.files.map((file, index) => (
              <View key={file.path}>
                {index > 0 ? <SheetRowDivider inset={false} /> : null}
                <SheetValueRow label={file.path} value={`+${file.additions} −${file.deletions}`} mono />
              </View>
            ))}
          </SheetCard>
          {detail.missing.includes('files') && detail.files.length > 0 ? (
            <Text className="px-1 text-xs text-foreground-muted">Some changed files could not be read.</Text>
          ) : null}
        </View>

        <Conversation items={comments} unavailable={detail.missing.includes('comments')} />
      </ScrollView>
      <PrComposerSheet intent={intent} prTitle={pr.title} onSubmit={submit} onClose={() => setIntent(null)} />
    </>
  )
}

function PrHeader({ pr }: { pr: PullRequest }) {
  return (
    <View className="gap-1.5 px-1 pt-1">
      <PrStateBadge pr={pr} />
      <Text selectable accessibilityRole="header" className="text-xl font-t3-bold text-foreground">{pr.title}</Text>
      <Text className="text-sm leading-snug text-foreground-muted">
        {pr.author} wants to merge{' '}
        <Text className="text-foreground-secondary" style={{ fontFamily: CODE_FONT }}>{pr.headRef}</Text>
        {' '}into{' '}
        <Text className="text-foreground-secondary" style={{ fontFamily: CODE_FONT }}>{pr.baseRef}</Text>
      </Text>
    </View>
  )
}

function ChecksSection({ detail, pr, onOpen }: { detail: PullRequestDetail; pr: PullRequest; onOpen: (url: string) => void }) {
  const summary = checksLabel(detail.checks, pr.headSha)
  const checks = detail.checks && detail.checks.headSha === pr.headSha ? [...detail.checks.required, ...detail.checks.optional] : []
  if (!summary && !detail.missing.includes('checks')) return null
  return (
    <View className="gap-2">
      <SheetSectionLabel>{summary?.label ?? 'Checks'}</SheetSectionLabel>
      <SheetCard>
        {checks.map((check, index) => {
          const status = checkItemLabel(check)
          const url = check.detailsUrl
          return (
            <View key={check.id}>
              {index > 0 ? <SheetRowDivider inset={false} /> : null}
              <SheetValueRow
                label={check.name}
                value={status.label}
                valueClassName={CHECK_TONE_TEXT[status.tone]}
                {...(url ? { onPress: () => onOpen(url) } : {})}
              />
            </View>
          )
        })}
        {checks.length === 0 ? <SheetValueRow label="Checks" value="Unavailable" /> : null}
      </SheetCard>
    </View>
  )
}

/** A description or comment, in the transcript's selectable markdown. Web links open in the browser. */
function PrMarkdown({ markdown }: { markdown: string }) {
  const app = useApp()
  const textStyle = useNativeMarkdownTextStyle('assistant')
  const onLinkPress = useCallback((href: string) => {
    const presentation = resolveMarkdownLinkPresentation(href)
    if (presentation.kind === 'external') void app.platform.openBrowser(presentation.href)
    else if (presentation.kind === 'link' && presentation.href) void Linking.openURL(presentation.href)
  }, [app])
  return <SelectableMarkdownText markdown={markdown} textStyle={textStyle} onLinkPress={onLinkPress} />
}

/** Each comment as T3 Code's review comment card: author and age, then the body. */
function Conversation({ items, unavailable }: { items: PrCommentActivityItem[]; unavailable: boolean }) {
  const now = Date.now()
  return (
    <View className="gap-2">
      <SheetSectionLabel>Conversation</SheetSectionLabel>
      {items.length === 0 ? (
        <SheetCard>
          <SheetValueRow label="Comments" value={unavailable ? 'Unavailable' : 'None yet'} />
        </SheetCard>
      ) : (
        items.map((item) => (
          <View key={item.id} className="w-full overflow-hidden rounded-[16px] border border-border bg-card">
            <View className="flex-row items-center gap-2 border-b border-border px-3 py-2">
              <View className="size-6 items-center justify-center rounded-[7px] bg-subtle">
                <Text className="text-2xs font-t3-bold text-foreground-muted">{item.author.slice(0, 1).toUpperCase()}</Text>
              </View>
              <View className="min-w-0 flex-1">
                <Text className="text-xs text-foreground" numberOfLines={1} style={{ fontFamily: CODE_FONT }}>{item.author}</Text>
              </View>
              <Text className="text-xs text-foreground-muted">
                {[item.reviewState ? reviewerStateLabel(item.reviewState) : null, prAge(item.createdAt, now)].filter(Boolean).join(' · ')}
              </Text>
            </View>
            {item.body.trim() ? (
              <View className="px-3 py-3">
                <PrMarkdown markdown={item.body} />
              </View>
            ) : null}
          </View>
        ))
      )}
      {unavailable && items.length > 0 ? <Text className="px-1 text-xs text-foreground-muted">Some of the conversation could not be read.</Text> : null}
    </View>
  )
}
