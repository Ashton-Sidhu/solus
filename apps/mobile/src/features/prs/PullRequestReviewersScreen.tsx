// Adapted from T3 Code apps/mobile/src/features/pull-requests/PullRequestReviewersScreen.tsx (MIT, see UPSTREAM.md).
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, FlatList, Platform, Pressable, View } from 'react-native'
import type { PrReviewerCandidate } from '@solus/contracts/providers'
import { useApp, useListened } from '../../app/app-context'
import { SymbolView } from '../../components/AppSymbol'
import { AppText as Text, AppTextInput as TextInput } from '../../components/AppText'
import { EmptyState } from '../../components/EmptyState'
import { SheetHeader } from '../../components/SheetHeader'
import type { ScreenProps } from '../../navigation/routes'
import { pullRequestPermissions } from './lib/pull-request-permissions'
import { shownValue } from './pull-request-reads'
import { PullRequestAvatar } from './detail/pull-request-ui'
import { OFFLINE_REASON } from './detail/pull-request-view'

type UserCandidate = Extract<PrReviewerCandidate, { kind: 'user' }>

/**
 * Asks people for a review, or takes the request back. The host lists who can
 * review; GitHub teams are asked on GitHub, because the host requests people
 * by login only. A person who already reviewed is not "requested" any more.
 */
export function PullRequestReviewersScreen({ navigation, route }: ScreenProps<'PullRequestReviewers'>) {
  const { hostId, projectPath, number } = route.params
  const ref = useMemo(() => ({ hostId, projectPath, number }), [hostId, projectPath, number])
  const app = useApp()
  const state = useListened(app.pullRequests.changes, () => app.pullRequests.detailOf(ref))
  const viewerLogin = useListened(app.pullRequests.changes, () => shownValue(app.pullRequests.hostOf(hostId))?.viewerLogin ?? null)
  const connected = useListened(app.connections.changes, () => app.connections.state(hostId)?.readiness === 'ready')
  const detail = shownValue(state)
  const permissions = pullRequestPermissions(detail?.overview.pullRequest ?? null, viewerLogin, connected)
  const [candidates, setCandidates] = useState<{ kind: 'loading' } | { kind: 'loaded'; users: UserCandidate[] } | { kind: 'error'; message: string }>({ kind: 'loading' })
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadCandidates = useCallback(() => {
    if (!connected || !permissions.hasReviewerCandidates) return
    setCandidates({ kind: 'loading' })
    app.pullRequestActions.reviewerCandidates(ref).then(
      (list) => setCandidates({ kind: 'loaded', users: list.filter((entry): entry is UserCandidate => entry.kind === 'user') }),
      (cause: unknown) => setCandidates({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) }),
    )
  }, [app, ref, connected, permissions.hasReviewerCandidates])
  useEffect(loadCandidates, [loadCandidates])

  const requested = useMemo(() => new Set((detail?.overview.reviewers ?? []).filter((reviewer) => reviewer.state === null).map((reviewer) => reviewer.login.toLowerCase())), [detail])
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const users = candidates.kind === 'loaded' ? candidates.users : []
    // Requested people stay listed even when the host did not list them as candidates.
    const known = new Set(users.map((user) => user.login.toLowerCase()))
    const extra = (detail?.overview.reviewers ?? []).filter((reviewer) => reviewer.state === null && !known.has(reviewer.login.toLowerCase()))
      .map((reviewer) => {
        const candidate: UserCandidate = { kind: 'user', login: reviewer.login }
        if (reviewer.avatarUrl) candidate.avatarUrl = reviewer.avatarUrl
        return candidate
      })
    return [...extra, ...users]
      .filter((user) => user.login.toLowerCase().includes(needle))
      .sort((a, b) => Number(requested.has(b.login.toLowerCase())) - Number(requested.has(a.login.toLowerCase())) || a.login.localeCompare(b.login))
  }, [candidates, detail, query, requested])

  const toggle = async (user: UserCandidate) => {
    if (!permissions.canRequestReviewers || pending) return
    setPending(user.login)
    setError(null)
    // The React Compiler cannot compile try/finally. The async wrapper turns a
    // synchronous throw into a rejection, so catch and finally see both.
    await (async () => {
      if (requested.has(user.login.toLowerCase())) await app.pullRequestActions.removeReviewer(ref, user.login, 'user')
      else await app.pullRequestActions.requestReviewers(ref, [user.login])
    })().catch((cause) => {
      setError(cause instanceof Error ? cause.message : 'Could not change this review request. Try again.')
    }).finally(() => {
      setPending(null)
    })
  }

  return (
    <View className="flex-1 bg-sheet">
      <SheetHeader
        presentation={Platform.OS === 'android' ? 'inline' : 'native'}
        title="Request review"
        subtitle={`#${number}`}
        onClose={() => navigation.goBack()}
        accessibilityLabel="Close request review"
      />
      <FlatList
        data={rows}
        keyExtractor={(user) => user.login}
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: 24 }}
        ListHeaderComponent={
          <View className="gap-3 px-4 py-4">
            <Text className="text-xs text-foreground-muted">Tap a person to ask for a review. Tap a requested reviewer to take the request back.</Text>
            <TextInput
              accessibilityLabel="Search reviewers"
              placeholder="Search reviewers"
              placeholderTextColorClassName="accent-placeholder"
              value={query}
              onChangeText={setQuery}
              autoCapitalize="none"
              autoCorrect={false}
              className="min-h-11 rounded-xl bg-grouped-card px-3 text-sm text-foreground"
            />
            {!connected ? <Text className="text-xs text-foreground-muted">{OFFLINE_REASON}</Text> : !permissions.canRequestReviewers ? <Text className="text-xs text-foreground-muted">Asking for reviews needs write access and an open pull request.</Text> : null}
            {error ? <Text selectable className="text-sm text-danger-foreground">{error}</Text> : null}
          </View>
        }
        renderItem={({ item }) => {
          const isRequested = requested.has(item.login.toLowerCase())
          const disabled = !permissions.canRequestReviewers || pending !== null
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${isRequested ? 'Take back the review request from' : 'Ask for a review from'} ${item.login}`}
              accessibilityState={{ disabled }}
              disabled={disabled}
              onPress={() => void toggle(item)}
              className="min-h-16 flex-row items-center gap-3 border-b border-border-subtle px-4 py-3 active:opacity-70"
            >
              <PullRequestAvatar login={item.login} avatarUrl={item.avatarUrl ?? null} size={32} />
              <Text className="min-w-0 flex-1 text-sm font-t3-medium" numberOfLines={1}>{item.login}</Text>
              {pending === item.login ? <ActivityIndicator /> : isRequested ? (
                <View className="flex-row items-center gap-1.5">
                  <Text className="text-xs text-foreground-muted">Requested</Text>
                  <SymbolView name="checkmark" size={14} tintColorClassName="accent-icon" />
                </View>
              ) : (
                <SymbolView name="plus" size={16} tintColorClassName="accent-icon-muted" />
              )}
            </Pressable>
          )
        }}
        ListEmptyComponent={
          candidates.kind === 'loading' && connected && permissions.hasReviewerCandidates ? <ActivityIndicator className="my-8" /> : (
            <View className="px-4 py-6">
              <EmptyState
                variant="plain"
                title={candidates.kind === 'error' ? 'Could not load reviewers' : query.trim() ? 'No matching reviewers' : 'No reviewers available'}
                detail={candidates.kind === 'error' ? candidates.message : !connected ? OFFLINE_REASON : 'People with access to this repository show here.'}
                {...(candidates.kind === 'error' ? { actionLabel: 'Try again', onAction: loadCandidates } : {})}
              />
            </View>
          )
        }
      />
    </View>
  )
}
