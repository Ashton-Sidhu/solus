// Adapted from T3 Code apps/mobile/src/features/pull-requests/PullRequestReviewSheet.tsx (MIT, see UPSTREAM.md).
import { StackActions } from '@react-navigation/native'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Pressable, View } from 'react-native'
import type { PrReviewVerdict } from '@solus/contracts/providers'
import { useApp, useListened } from '../../app/app-context'
import { AppText as Text, AppTextInput as TextInput } from '../../components/AppText'
import { MaterialButton } from '../../components/MaterialButton'
import { SegmentedControl } from '../../components/SegmentedControl'
import type { RootStackParamList, ScreenProps } from '../../navigation/routes'
import { CODE_FONT } from '../../theme/tokens'
import { pullRequestPermissions } from './lib/pull-request-permissions'
import { canSubmitReview, currentReviewComments, outdatedReviewComments, reviewBlockedReason, reviewCommentLabel, reviewSubmitLabel, type PendingReviewComment, type ReviewDraft } from './lib/pull-request-review-draft'
import { shownValue } from './pull-request-reads'
import { PullRequestSheetContent } from './detail/PullRequestSheetContent'

const VERDICTS = {
  comment: 'Comment',
  approve: 'Approve',
  'request-changes': 'Request changes',
} as const satisfies Record<PrReviewVerdict, string>

/**
 * Submits one review, or posts one comment on the conversation. A review
 * takes a verdict, a summary, and the draft comments written on the current
 * head; comments written on an older head stay in the draft and are not sent.
 */
export function PullRequestReviewSheet({ navigation, route }: ScreenProps<'PullRequestReview'>) {
  const { hostId, projectPath, number, mode } = route.params
  const ref = useMemo(() => ({ hostId, projectPath, number }), [hostId, projectPath, number])
  const reviewing = mode === 'review'
  const app = useApp()
  const state = useListened(app.pullRequests.changes, () => app.pullRequests.detailOf(ref))
  const viewerLogin = useListened(app.pullRequests.changes, () => shownValue(app.pullRequests.hostOf(ref.hostId))?.viewerLogin ?? null)
  const connected = useListened(app.connections.changes, () => app.connections.state(ref.hostId)?.readiness === 'ready')
  const draft = useListened(app.reviewDrafts.changes, () => app.reviewDrafts.draftOf(ref))
  const saveError = useListened(app.reviewDrafts.changes, () => app.reviewDrafts.saveError)
  const pr = shownValue(state)?.overview.pullRequest ?? null
  const permissions = pullRequestPermissions(pr, viewerLogin, connected)
  const [comment, setComment] = useState('')
  const [requested, setRequested] = useState<PrReviewVerdict>('comment')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pending = useRef(false)
  useEffect(() => { void app.reviewDrafts.load(ref) }, [app, ref])

  const verdict = permissions.verdicts.includes(requested) ? requested : permissions.verdicts[0]
  const current = pr ? currentReviewComments(draft, pr.headSha) : []
  const outdated = pr ? outdatedReviewComments(draft, pr.headSha) : []
  const body = reviewing ? draft.summary : comment
  const canSubmit = !!pr && !busy && canSubmitReview({ reviewing, verdict, body, currentCount: current.length, canComment: permissions.canComment })
  const reason = reviewBlockedReason({ connected, hasPullRequest: pr !== null, reviewing, verdictCount: permissions.verdicts.length, canComment: permissions.canComment })

  const submit = async () => {
    if (!pr || !canSubmit || pending.current) return
    pending.current = true
    setBusy(true)
    setError(null)
    // The React Compiler cannot compile try/finally. The async wrapper turns a
    // synchronous throw into a rejection, so catch and finally see both.
    await (async () => {
      if (reviewing && verdict) await app.pullRequestActions.submitReview(ref, { verdict, body, headSha: pr.headSha })
      else await app.pullRequestActions.comment(ref, body)
      navigation.goBack()
    })().catch((cause) => {
      setError(cause instanceof Error ? cause.message : 'GitHub could not take this. Try again.')
    }).finally(() => {
      pending.current = false
      setBusy(false)
    })
  }
  const discard = () => Alert.alert('Discard this review?', 'The summary and every draft comment are removed from this device.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Discard', style: 'destructive', onPress: () => { app.reviewDrafts.discard(ref); navigation.goBack() } },
  ])
  const submitLabel = reviewSubmitLabel(busy, reviewing, verdict)
  const editComment = (entry: PendingReviewComment) => {
    const params: RootStackParamList['PullRequestInlineComment'] = { ...ref, path: entry.path, side: entry.side, line: entry.line, headSha: entry.headSha, code: '', draftId: entry.id }
    if (entry.startLine !== undefined) params.startLine = entry.startLine
    navigation.dispatch(StackActions.replace('PullRequestInlineComment', params))
  }

  return (
    <PullRequestSheetContent
      title={reviewing ? 'Submit review' : 'Add comment'}
      subtitle={`#${ref.number}${reviewing && pr ? ` · reviewing ${pr.headSha.slice(0, 7)}` : ''}`}
      busy={busy}
      footer={<MaterialButton label={submitLabel} fullWidth tone="primary" loading={busy} disabled={!canSubmit || reason !== null} onPress={() => void submit()} />}
    >
      {reviewing && permissions.verdicts.length > 1 ? (
        <SegmentedControl
          options={permissions.verdicts.map((value) => ({ value, label: VERDICTS[value] }))}
          selected={verdict ?? 'comment'}
          onSelect={(value) => { if (!busy) setRequested(value) }}
          size="compact"
        />
      ) : null}
      <ReviewBodyField
        reviewing={reviewing}
        busy={busy}
        body={body}
        onChange={(text) => (reviewing ? app.reviewDrafts.setSummary(ref, text) : setComment(text))}
      />
      {reviewing && draft.comments.length > 0 ? (
        <PendingComments
          current={current}
          outdated={outdated}
          busy={busy}
          onEdit={editComment}
          onRemove={(entry) => app.reviewDrafts.removeComment(ref, entry.id)}
        />
      ) : null}
      <ReviewNotes
        reviewing={reviewing}
        outdatedCount={outdated.length}
        reason={reason}
        error={error ?? saveError}
        draft={draft}
        busy={busy}
        onDiscard={discard}
      />
    </PullRequestSheetContent>
  )
}

/** The text of the review summary, or of the comment. */
function ReviewBodyField(props: { readonly reviewing: boolean; readonly busy: boolean; readonly body: string; readonly onChange: (text: string) => void }) {
  const { reviewing } = props
  return (
    <>
      <Text className="px-1 text-xs text-foreground-muted">{reviewing ? 'Summary' : 'Comment'}</Text>
      <TextInput
        multiline
        autoFocus={!reviewing}
        accessibilityLabel={reviewing ? 'Review summary' : 'Comment'}
        placeholder={reviewing ? 'Summarize your review…' : 'Write a comment…'}
        placeholderTextColorClassName="accent-placeholder"
        editable={!props.busy}
        value={props.body}
        maxLength={65536}
        onChangeText={props.onChange}
        className="min-h-36 rounded-[20px] bg-grouped-card p-4 text-base text-foreground"
        style={{ textAlignVertical: 'top' }}
      />
    </>
  )
}

/** The draft line comments: the ones this review sends, then the ones on an older head. */
function PendingComments(props: {
  readonly current: readonly PendingReviewComment[]
  readonly outdated: readonly PendingReviewComment[]
  readonly busy: boolean
  readonly onEdit: (entry: PendingReviewComment) => void
  readonly onRemove: (entry: PendingReviewComment) => void
}) {
  const { current, outdated, busy } = props
  return (
    <View className="gap-2">
      <Text className="text-sm font-t3-medium">{`${current.length} pending line ${current.length === 1 ? 'comment' : 'comments'}`}</Text>
      {[...current, ...outdated].map((entry) => {
        const old = outdated.includes(entry)
        return (
          <View key={entry.id} className="gap-1 rounded-[20px] bg-grouped-card p-4">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Edit comment on ${entry.path}, ${reviewCommentLabel(entry)}`}
              disabled={busy}
              onPress={() => props.onEdit(entry)}
              className="gap-1 active:opacity-70"
            >
              <Text className="text-xs text-foreground-muted" style={{ fontFamily: CODE_FONT }} numberOfLines={1} ellipsizeMode="head">{`${entry.path} · ${reviewCommentLabel(entry)}`}</Text>
              <Text numberOfLines={3} className="text-sm">{entry.body}</Text>
            </Pressable>
            <View className="flex-row items-center justify-between gap-2">
              <Text className={old ? 'text-2xs text-danger-foreground' : 'text-2xs text-foreground-muted'}>
                {old ? 'Written on an older head · not sent' : 'Tap to edit'}
              </Text>
              <MaterialButton label="Remove" tone="text" disabled={busy} onPress={() => props.onRemove(entry)} />
            </View>
          </View>
        )
      })}
    </View>
  )
}

/** The notes under the form: comments that are not sent, what stops the send, an error, and the discard button. */
function ReviewNotes(props: {
  readonly reviewing: boolean
  readonly outdatedCount: number
  readonly reason: string | null
  readonly error: string | null
  readonly draft: ReviewDraft
  readonly busy: boolean
  readonly onDiscard: () => void
}) {
  const { reviewing, reason, error, draft } = props
  return (
    <>
      {reviewing && props.outdatedCount > 0 ? (
        <Text className="text-sm text-foreground-muted">The branch changed after you wrote some comments. They stay here, but this review does not send them.</Text>
      ) : null}
      {reason ? <Text className="text-sm text-foreground-muted">{reason}</Text> : null}
      {error ? <Text selectable className="text-sm text-danger-foreground">{error}</Text> : null}
      {reviewing && (draft.summary.trim() || draft.comments.length > 0) ? (
        <MaterialButton label="Discard review" tone="danger" disabled={props.busy} onPress={props.onDiscard} />
      ) : null}
    </>
  )
}
