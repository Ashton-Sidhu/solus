import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { Alert, Linking, ScrollView, View } from 'react-native'
import { githubMediaRepository } from '@solus/contracts/github-media'
import { PullRequestMediaContext } from './detail/use-pull-request-media-url'
import { PrUrlInspectionStore } from '@solus/client-core/pr-social'
import { useApp, useListened } from '../../app/app-context'
import { AppText as Text } from '../../components/AppText'
import { SettingsScreen } from '../settings/components/SettingsScreen'
import type { ScreenProps } from '../../navigation/routes'
import { ActionButton } from '../../components/FormControls'
import { PullRequestMarkdown } from './detail/PullRequestMarkdown'

export function PrInspectScreen({ route }: ScreenProps<'PrInspect'>) {
  const { hostId, url } = route.params,
    app = useApp()
  const identity = useListened(app.account.changes, () =>
    JSON.stringify([app.account.syncAccount, app.account.organizationId])
  )
  const store = useMemo(
    () =>
      new PrUrlInspectionStore(() => {
        if (JSON.stringify([app.account.syncAccount, app.account.organizationId]) !== identity)
          throw new Error('The account changed. Refresh this PR.')
        const connection = app.connections.connection(hostId)
        if (!connection || connection.state.readiness !== 'ready')
          throw new Error('The PR host is disconnected.')
        return connection.api
      }),
    [app, identity, hostId]
  )
  const snapshot = useSyncExternalStore(
    store.subscribe,
    () => store.current,
    () => store.current
  )
  useEffect(() => {
    void store.open(url)
    return () => store.close()
  }, [store, url])
  const value = snapshot.value,
    pr = value?.overview.pullRequest
  const repository = pr ? githubMediaRepository(pr.baseRepo) : undefined
  const mediaLocation = useMemo(() => ({ hostId, repository }), [hostId, repository])
  return (
    <PullRequestMediaContext.Provider value={mediaLocation}>
      <SettingsScreen title="Inspect PR">
        <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
          <Text className="text-sm text-foreground-muted">
            Read-only inspection. This does not add a project or prepare a checkout.
          </Text>
          {snapshot.error ? (
            <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
              {snapshot.error}
            </Text>
          ) : null}
          <ActionButton disabled={snapshot.pending} onPress={() => void store.open(url)}>
            {snapshot.pending ? 'Loading…' : snapshot.error ? 'Retry' : 'Refresh'}
          </ActionButton>
          {pr && value ? (
            <>
              <Text className="text-xl font-t3-medium text-foreground">
                #{pr.number} {pr.title}
              </Text>
              <Text className="text-sm text-foreground-muted">
                {pr.baseRepo.owner}/{pr.baseRepo.repo} · {pr.state}
              </Text>
              <PullRequestMarkdown markdown={pr.body} />
              {value.truncated ? (
                <Text className="text-sm text-foreground-muted">
                  Some content is not shown. Open on GitHub to read the full conversation.
                </Text>
              ) : null}
              <ActionButton
                onPress={() =>
                  void Linking.openURL(pr.url).catch(() => Alert.alert('Could not open GitHub'))
                }
              >
                Open on GitHub
              </ActionButton>
              {value.comments.map((comment) =>
                comment.kind === 'label' ? null : (
                  <View key={comment.id} className="gap-2 border-t border-border pt-3">
                    <Text className="text-sm text-foreground-muted">{comment.author}</Text>
                    <PullRequestMarkdown markdown={comment.body} />
                  </View>
                )
              )}
              {value.threads.map((thread) => (
                <View key={thread.id} className="gap-2 border-t border-border pt-3">
                  {thread.comments.map((comment) => (
                    <View key={comment.id} className="gap-1">
                      <Text className="text-sm text-foreground-muted">
                        {comment.author} · Inline comment
                      </Text>
                      <PullRequestMarkdown markdown={comment.body} />
                    </View>
                  ))}
                </View>
              ))}
            </>
          ) : null}
        </ScrollView>
      </SettingsScreen>
    </PullRequestMediaContext.Provider>
  )
}
