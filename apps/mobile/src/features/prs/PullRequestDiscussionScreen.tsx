// Adapted from T3 Code apps/mobile/src/features/pull-requests/PullRequestDiscussionScreen.tsx (MIT, see UPSTREAM.md).
import type { ReviewThread } from '@solus/contracts/providers'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Pressable, ScrollView, View } from 'react-native'
import { KeyboardAvoidingView } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useApp, useListened } from '../../app/app-context'
import { AppText as Text, AppTextInput as TextInput } from '../../components/AppText'
import { MaterialButton } from '../../components/MaterialButton'
import type { ScreenProps } from '../../navigation/routes'
import { NativeScrollView } from '../../native/NativeScrollViewMarker'
import { CODE_FONT } from '../../theme/tokens'
import { HostStatusBanner } from '../hosts/HostStatusBanner'
import { prAge } from './lib/pr-presentation'
import { pullRequestPermissions } from './lib/pull-request-permissions'
import { shownValue } from './pull-request-reads'
import { PullRequestMarkdown } from './detail/PullRequestMarkdown'
import { PullRequestMediaContext } from './detail/use-pull-request-media-url'
import { PullRequestAvatar } from './detail/pull-request-ui'
import { OFFLINE_REASON } from './detail/pull-request-view'

/**
 * One review thread: where it is, its comments, a reply, and resolve or
 * unresolve. Both writes need the host; offline the thread stays readable
 * from the device copy.
 */
export function PullRequestDiscussionScreen({ navigation, route }: ScreenProps<'PullRequestDiscussion'>) {
  const { hostId, projectPath, number, threadId } = route.params
  const ref = useMemo(() => ({ hostId, projectPath, number }), [hostId, projectPath, number])
  const app = useApp()
  const insets = useSafeAreaInsets()
  const state = useListened(app.pullRequests.changes, () => app.pullRequests.detailOf(ref))
  const viewerLogin = useListened(app.pullRequests.changes, () => shownValue(app.pullRequests.hostOf(hostId))?.viewerLogin ?? null)
  const connected = useListened(app.connections.changes, () => app.connections.state(hostId)?.readiness === 'ready')
  const running = useListened(app.pullRequestActions.changes, () => app.pullRequestActions.runningOf(ref))
  const detail = shownValue(state)
  const permissions = pullRequestPermissions(detail?.overview.pullRequest ?? null, viewerLogin, connected)
  const thread = detail?.threads.find((entry) => entry.id === threadId) ?? null
  const [body, setBody] = useState('')
  const [error, setError] = useState<string | null>(null)
  const pending = useRef(false)
  const busy = running === 'thread'

  const run = async (write: () => Promise<void>) => {
    if (pending.current) return false
    pending.current = true
    setError(null)
    // The React Compiler cannot compile try/finally. The async wrapper turns a
    // synchronous throw into a rejection, so catch and finally see both.
    return await (async () => {
      await write()
      return true
    })().catch((cause) => {
      setError(cause instanceof Error ? cause.message : 'GitHub could not take this. Try again.')
      return false
    }).finally(() => {
      pending.current = false
    })
  }
  const reply = async () => {
    const submitted = body
    if (!thread || !submitted.trim()) return
    if (await run(() => app.pullRequestActions.replyToThread(ref, thread.id, submitted))) setBody((current) => (current === submitted ? '' : current))
  }
  const toggleResolved = () => {
    if (thread) void run(() => app.pullRequestActions.setThreadResolved(ref, thread.id, !thread.isResolved))
  }

  useLayoutEffect(() => {
    navigation.setOptions({
      title: 'Discussion',
      headerRight: permissions.canResolve && thread ? () => (
        <Pressable accessibilityRole="button" disabled={busy} onPress={toggleResolved} hitSlop={8} className="min-h-9 justify-center px-2 active:opacity-60 disabled:opacity-40">
          <Text className="text-base font-t3-medium text-primary-text">{thread.isResolved ? 'Unresolve' : 'Resolve'}</Text>
        </Pressable>
      ) : undefined,
    })
    // `toggleResolved` reads only `thread`, which the list names.
  }, [navigation, permissions.canResolve, thread, busy])

  const now = Date.now()
  return (
    <PullRequestMediaContext.Provider value={ref}>
      <KeyboardAvoidingView behavior="padding" className="flex-1 bg-screen">
        <NativeScrollView className="flex-1" contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 20, paddingBottom: 24 }}>
          <HostStatusBanner hostId={hostId} />
          {state.kind === 'error' && detail ? <Text className="pb-3 text-xs text-foreground-muted">{`Not refreshed: ${state.message}`}</Text> : null}
          {thread ? (
            <ThreadLocation thread={thread} />
          ) : (
            <Text className="text-sm text-foreground-muted">{detail ? 'This discussion is no longer on the pull request.' : 'Loading discussion…'}</Text>
          )}
          {thread?.comments.map((comment) => (
            <View key={comment.id} className="gap-3 border-b border-border-subtle py-4">
              <View className="flex-row items-center gap-2">
                <PullRequestAvatar login={comment.author} avatarUrl={comment.authorAvatarUrl ?? null} size={28} />
                <Text className="min-w-0 flex-1 text-sm font-t3-medium" numberOfLines={1}>{comment.author}</Text>
                <Text className="text-2xs text-foreground-muted">{prAge(comment.createdAt, now)}</Text>
              </View>
              <PullRequestMarkdown markdown={comment.body} />
            </View>
          ))}
          {error ? <Text selectable className="py-4 text-sm text-danger-foreground">{error}</Text> : null}
        </NativeScrollView>
        {thread ? (
          <View className="flex-row items-end gap-2 border-t border-border-subtle bg-screen px-4 pt-2" style={{ paddingBottom: Math.max(insets.bottom, 12) }}>
            {permissions.canReply ? (
              <>
                <TextInput
                  accessibilityLabel="Reply to discussion"
                  multiline
                  maxLength={65536}
                  placeholder="Reply…"
                  placeholderTextColorClassName="accent-placeholder"
                  value={body}
                  onChangeText={setBody}
                  editable={!busy}
                  className="max-h-36 min-h-11 min-w-0 flex-1 rounded-[22px] bg-grouped-card px-4 py-3 text-base text-foreground"
                />
                <MaterialButton label={busy ? 'Posting…' : 'Reply'} tone="primary" loading={busy} disabled={!body.trim()} onPress={() => void reply()} />
              </>
            ) : (
              <Text className="flex-1 py-2 text-xs text-foreground-muted">{connected ? 'Your account cannot reply to this discussion.' : OFFLINE_REASON}</Text>
            )}
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </PullRequestMediaContext.Provider>
  )
}

/** Where the thread is: the file and line, its state, and the end of its diff hunk. */
function ThreadLocation({ thread }: { readonly thread: ReviewThread }) {
  const hunk = thread.comments[0]?.diffHunk
  return (
    <View className="gap-2 pb-4">
      <Text selectable className="text-xs text-foreground-muted" style={{ fontFamily: CODE_FONT }}>{thread.filePath}{thread.line ? `:${thread.line}` : ''}</Text>
      <Text className="text-xs text-foreground-muted">{thread.isResolved ? 'Resolved' : 'Unresolved'}{thread.isOutdated ? ' · Outdated' : ''}</Text>
      {hunk ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} className="rounded-xl bg-grouped-card">
          <Text selectable className="p-3 text-xs" style={{ fontFamily: CODE_FONT }}>{hunk.split('\n').slice(-6).join('\n')}</Text>
        </ScrollView>
      ) : null}
    </View>
  )
}
