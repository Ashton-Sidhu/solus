import { useCallback, useEffect, useLayoutEffect, useState, type ReactNode } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import { ActionSheetIOS, ActivityIndicator, Alert, Platform, RefreshControl, Text, View } from 'react-native'
import type { PrCommentActivityItem, PullRequest } from '@solus/contracts/providers'
import { useApp, useListened } from '../../app/app-context'
import type { ScreenProps } from '../../navigation/routes'
import { usePalette } from '../../theme/theme'
import { CODE_FONT, space } from '../../theme/tokens'
import { GroupedFooter, GroupedScroll, GroupedSection, NavigationRow, ValueRow } from '../../ui/grouped-rows'
import { Banner, Button, EmptyState } from '../../ui/primitives'
import { MarkdownText } from '../conversation/components/MarkdownText'
import { HostStatusBanner } from '../hosts/HostStatusBanner'
import { PrComposerSheet, type PrComposerIntent } from './components/PrComposerSheet'
import { PrStateBadge } from './components/PrStateBadge'
import { canGiveVerdict, checkItemLabel, checksLabel, prAge, reviewerStateLabel, reviewStatusLabel } from './lib/pr-presentation'
import { shownValue, type PullRequestDetail, type PullRequestRef } from './pull-request-directory'

/**
 * One pull request: what it changes, where its checks and reviews stand, and
 * its conversation. The phone comments, approves, or requests changes; merging
 * and the diff stay on the computer for now (apps/mobile/README.md).
 */
export function PullRequestScreen({ navigation, route }: ScreenProps<'PullRequest'>) {
  const ref: PullRequestRef = route.params
  const { hostId, projectPath, number } = ref
  const app = useApp()
  const palette = usePalette()
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
      <View style={{ flex: 1, backgroundColor: palette.canvas }}>
        <HostStatusBanner hostId={hostId} />
        {state.kind === 'error' ? (
          state.githubAuth
            ? <EmptyState title="Connect GitHub to read this pull request" message="The host reads pull requests with its own GitHub connection." action={<Button tone="primary" label="Connect GitHub" onPress={() => navigation.navigate('GitHubConnection', { hostId })} />} />
            : <View style={{ padding: space.lg }}><Banner message={`The pull request could not be read: ${state.message}`} action={<Button label="Try again" onPress={reload} />} /></View>
        ) : <View style={{ padding: space.xl }}><ActivityIndicator accessibilityLabel="Reading the pull request" /></View>}
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

  return (
    <>
      <GroupedScroll refreshControl={<RefreshControl refreshing={state.kind === 'loading'} onRefresh={reload} />}>
        <HostStatusBanner hostId={hostId} />
        {state.kind === 'error' ? <Banner message={`Not refreshed: ${state.message}`} /> : null}
        <PrHeader pr={pr} />
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          <Button label="Open on GitHub" onPress={() => void app.platform.openBrowser(pr.url)} />
          {pr.viewerPermissions.comment ? <Button label="Comment" onPress={() => setIntent({ kind: 'comment' })} /> : null}
          {reviewVerdicts.length > 0 ? <Button tone="primary" label="Review" onPress={chooseReview} /> : null}
        </View>

        <GroupedSection title="Description">
          <View style={{ padding: 14 }}>
            {pr.body.trim() ? <MarkdownText text={pr.body} /> : <Text style={{ color: palette.textTertiary, fontSize: 15 }}>No description.</Text>}
          </View>
        </GroupedSection>

        <ChecksSection detail={detail} pr={pr} onOpen={(url) => void app.platform.openBrowser(url)} />

        {detail.overview.reviewers.length > 0 ? (
          <GroupedSection title="Reviewers">
            {detail.overview.reviewers.map((reviewer, index) => (
              <ValueRow key={reviewer.login} isFirst={index === 0} label={reviewer.login} value={reviewerStateLabel(reviewer.state)} />
            ))}
          </GroupedSection>
        ) : null}

        <GroupedSection title={`Files · ${detail.files.length}`} footer={detail.missing.includes('files') ? 'The changed files could not be read.' : undefined}>
          {detail.files.length === 0 ? <ValueRow label="Files" value={detail.missing.includes('files') ? 'Unavailable' : 'None'} /> : null}
          {detail.files.map((file, index) => (
            <View key={file.path} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: index === 0 ? 0 : 1, borderTopColor: palette.border }}>
              <Text numberOfLines={1} ellipsizeMode="head" style={{ flex: 1, color: palette.text, fontSize: 13, fontFamily: CODE_FONT }}>{file.path}</Text>
              <Text style={{ color: palette.textTertiary, fontSize: 12, fontFamily: CODE_FONT }}>+{file.additions} −{file.deletions}</Text>
            </View>
          ))}
        </GroupedSection>

        <Conversation items={detail.comments.filter((item): item is PrCommentActivityItem => item.kind !== 'label')} unavailable={detail.missing.includes('comments')} />
      </GroupedScroll>
      <PrComposerSheet intent={intent} prTitle={pr.title} onSubmit={submit} onClose={() => setIntent(null)} />
    </>
  )
}

function PrHeader({ pr }: { pr: PullRequest }) {
  const palette = usePalette()
  const review = reviewStatusLabel(pr.reviewStatus)
  return (
    <View style={{ gap: 6, paddingHorizontal: 7 }}>
      <PrStateBadge pr={pr} />
      <Text selectable accessibilityRole="header" style={{ color: palette.text, fontSize: 22, lineHeight: 28, fontWeight: '700' }}>{pr.title}</Text>
      <Text style={{ color: palette.textTertiary, fontSize: 14, lineHeight: 20 }}>
        {pr.author} wants to merge <Text style={{ fontFamily: CODE_FONT, color: palette.textSecondary }}>{pr.headRef}</Text> into <Text style={{ fontFamily: CODE_FONT, color: palette.textSecondary }}>{pr.baseRef}</Text>
      </Text>
      <Text style={{ color: palette.textTertiary, fontSize: 13 }}>
        {[`+${pr.additions} −${pr.deletions}`, review, `updated ${prAge(pr.updatedAt, Date.now())}`].filter(Boolean).join(' · ')}
      </Text>
    </View>
  )
}

function ChecksSection({ detail, pr, onOpen }: { detail: PullRequestDetail; pr: PullRequest; onOpen: (url: string) => void }) {
  const summary = checksLabel(detail.checks, pr.headSha)
  const checks = detail.checks && detail.checks.headSha === pr.headSha ? [...detail.checks.required, ...detail.checks.optional] : []
  if (!summary && !detail.missing.includes('checks')) return null
  return (
    <GroupedSection title={summary?.label ?? 'Checks'} footer={detail.missing.includes('checks') ? 'The checks could not be read.' : undefined}>
      {checks.map((check, index) => {
        const status = checkItemLabel(check)
        const url = check.detailsUrl
        return url
          ? <NavigationRow key={check.id} label={check.name} value={status.label} onPress={() => onOpen(url)} />
          : <ValueRow key={check.id} isFirst={index === 0} label={check.name} value={status.label} />
      })}
      {checks.length === 0 ? <ValueRow label="Checks" value="Unavailable" /> : null}
    </GroupedSection>
  )
}

function Conversation({ items, unavailable }: { items: PrCommentActivityItem[]; unavailable: boolean }) {
  const palette = usePalette()
  const now = Date.now()
  let body: ReactNode
  if (items.length === 0) body = <ValueRow label="Comments" value={unavailable ? 'Unavailable' : 'None yet'} />
  else body = items.map((item, index) => (
    <View key={item.id} style={{ padding: 14, gap: 6, borderTopWidth: index === 0 ? 0 : 1, borderTopColor: palette.border }}>
      <Text style={{ color: palette.textTertiary, fontSize: 13 }}>
        <Text style={{ color: palette.text, fontWeight: '600' }}>{item.author}</Text>
        {item.reviewState ? ` · ${reviewerStateLabel(item.reviewState)}` : ''} · {prAge(item.createdAt, now)}
      </Text>
      {item.body.trim() ? <MarkdownText text={item.body} /> : null}
    </View>
  ))
  return (
    <>
      <GroupedSection title="Conversation">{body}</GroupedSection>
      {unavailable && items.length > 0 ? <GroupedFooter text="Some of the conversation could not be read." /> : null}
    </>
  )
}
