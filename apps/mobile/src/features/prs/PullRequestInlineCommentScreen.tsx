// Adapted from T3 Code apps/mobile/src/features/pull-requests/PullRequestInlineCommentScreen.tsx (MIT, see UPSTREAM.md).
import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, View } from 'react-native'
import { useApp, useListened } from '../../app/app-context'
import { AppText as Text, AppTextInput as TextInput } from '../../components/AppText'
import { MaterialButton } from '../../components/MaterialButton'
import type { ScreenProps } from '../../navigation/routes'
import { CODE_FONT } from '../../theme/tokens'
import { pullRequestPermissions } from './lib/pull-request-permissions'
import { canSaveReviewComment, reviewCommentLabel, type PendingReviewComment } from './lib/pull-request-review-draft'
import { shownValue } from './pull-request-reads'
import { PullRequestSheetContent } from './detail/PullRequestSheetContent'

/**
 * A review comment on one line or a range of lines. It goes into the review
 * draft on this device and is sent with the next review. A new comment
 * needs the head it was selected on; a draft from an older head can still
 * be edited or removed.
 */
export function PullRequestInlineCommentScreen({ navigation, route }: ScreenProps<'PullRequestInlineComment'>) {
  const { hostId, projectPath, number, path, side, line, startLine, headSha, code, draftId } = route.params
  const ref = useMemo(() => ({ hostId, projectPath, number }), [hostId, projectPath, number])
  const app = useApp()
  const draft = useListened(app.reviewDrafts.changes, () => app.reviewDrafts.draftOf(ref))
  const state = useListened(app.pullRequests.changes, () => app.pullRequests.detailOf(ref))
  const viewerLogin = useListened(app.pullRequests.changes, () => shownValue(app.pullRequests.hostOf(hostId))?.viewerLogin ?? null)
  const connected = useListened(app.connections.changes, () => app.connections.state(hostId)?.phase === 'connected')
  const pr = shownValue(state)?.overview.pullRequest ?? null
  const permissions = pullRequestPermissions(pr, viewerLogin, connected)
  const saved = draft.comments.find((comment) => comment.id === draftId)
  const [edited, setEdited] = useState<string | null>(null)
  const body = edited ?? saved?.body ?? ''
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  useEffect(() => { void app.reviewDrafts.load(ref) }, [app, ref])

  const stale = pr !== null && pr.headSha !== headSha
  const canSave = !busy && canSaveReviewComment({ body, isSaved: saved !== undefined, stale, canInlineComment: permissions.canInlineComment, connected })
  const label = reviewCommentLabel({ side, line, startLine })

  const save = async () => {
    if (!canSave || pending.current) return
    pending.current = true
    setBusy(true)
    try {
      if (saved) app.reviewDrafts.editComment(ref, saved.id, body)
      else {
        const comment: Omit<PendingReviewComment, 'id'> = { path, side, line, body, headSha }
        if (startLine !== undefined) comment.startLine = startLine
        app.reviewDrafts.addComment(ref, comment)
      }
      await app.reviewDrafts.flush()
      navigation.goBack()
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  const remove = () => {
    if (!saved) return
    Alert.alert('Delete this draft comment?', 'Your other review comments are kept.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => { app.reviewDrafts.removeComment(ref, saved.id); navigation.goBack() } },
    ])
  }

  return (
    <PullRequestSheetContent
      busy={busy}
      title={saved ? 'Edit review comment' : 'Review comment'}
      subtitle={`#${number} · ${label}`}
      footer={<MaterialButton fullWidth tone="primary" label={busy ? 'Saving…' : 'Save draft'} loading={busy} disabled={!canSave} onPress={() => void save()} />}
    >
      <View className="gap-2 rounded-[20px] bg-grouped-card p-4">
        <Text className="text-xs text-foreground-muted" style={{ fontFamily: CODE_FONT }} numberOfLines={1} ellipsizeMode="head">{path}</Text>
        {code ? <Text selectable className="text-xs" style={{ fontFamily: CODE_FONT }} numberOfLines={12}>{code}</Text> : null}
      </View>
      <TextInput
        multiline
        autoFocus
        editable={!busy}
        accessibilityLabel="Review comment"
        placeholder="Write feedback on these lines…"
        placeholderTextColorClassName="accent-placeholder"
        maxLength={65536}
        value={body}
        onChangeText={setEdited}
        className="min-h-32 rounded-[20px] bg-grouped-card p-4 text-base text-foreground"
        style={{ textAlignVertical: 'top' }}
      />
      <Text className="text-xs text-foreground-muted">Draft comments stay on this device until you submit your review.</Text>
      {stale ? (
        <Text className="text-sm text-danger-foreground">
          {saved ? 'The branch changed after you wrote this. It is not sent with a review of the new head.' : 'The branch changed. Load the new changes and select the lines again.'}
        </Text>
      ) : null}
      {!saved && connected && pr && !permissions.canInlineComment ? <Text className="text-sm text-foreground-muted">Your account cannot comment on lines of this pull request.</Text> : null}
      {saved ? <MaterialButton label="Delete draft" tone="danger" disabled={busy} onPress={remove} /> : null}
    </PullRequestSheetContent>
  )
}
