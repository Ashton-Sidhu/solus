import { useCallback, useEffect, useLayoutEffect, useMemo } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import { ActivityIndicator, Pressable, RefreshControl, SectionList, Text, View } from 'react-native'
import { useApp, useListened } from '../../app/app-context'
import type { ScreenProps } from '../../navigation/routes'
import { usePalette } from '../../theme/theme'
import { CODE_FONT, space } from '../../theme/tokens'
import { Banner, Button, EmptyState } from '../../ui/primitives'
import { HostStatusBanner } from '../hosts/HostStatusBanner'
import { PrStateBadge } from './components/PrStateBadge'
import { hostPrSections, prAge, prUnavailableTitle, reviewStatusLabel, type PrRowItem } from './lib/pr-presentation'
import { shownValue } from './pull-request-directory'

/**
 * The host's open pull requests across its projects, in the web's sections:
 * Authored, Review requested, Others. A project that cannot be read says why
 * under the list instead of hiding the rest.
 */
export function PullRequestsScreen({ navigation, route }: ScreenProps<'PullRequests'>) {
  const { hostId } = route.params
  const app = useApp()
  const palette = usePalette()
  const host = useListened(app.registry.changes, () => app.registry.host(hostId))
  const state = useListened(app.pullRequests.changes, () => app.pullRequests.hostOf(hostId))
  const phase = useListened(app.connections.changes, () => app.connections.state(hostId)?.phase)
  const reload = useCallback(() => { void app.pullRequests.loadHost(hostId) }, [app, hostId])

  useLayoutEffect(() => {
    navigation.setOptions({ title: 'Pull requests' })
  }, [navigation])

  useEffect(() => {
    if (phase === 'connected') reload()
  }, [phase, reload])

  useFocusEffect(reload)

  const listing = shownValue(state)
  const sections = useMemo(() => hostPrSections(listing), [listing])
  const notShown = listing?.projects.filter((project) => project.kind !== 'page') ?? []
  const now = Date.now()

  if (state.kind === 'error' && state.githubAuth) {
    return (
      <View style={{ flex: 1, backgroundColor: palette.canvas }}>
        <HostStatusBanner hostId={hostId} />
        <EmptyState
          title="Connect GitHub to see pull requests"
          message={`${host?.label ?? 'This host'} reads pull requests with its own GitHub connection.`}
          action={<Button tone="primary" label={`Connect GitHub on ${host?.label ?? 'this host'}`} onPress={() => navigation.navigate('GitHubConnection', { hostId })} />}
        />
      </View>
    )
  }

  return (
    <SectionList
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: palette.canvas }}
      sections={sections}
      keyExtractor={(item) => `${item.projectPath}#${item.pr.number}`}
      stickySectionHeadersEnabled={false}
      refreshControl={<RefreshControl refreshing={state.kind === 'loading' && listing !== null} onRefresh={reload} />}
      ListHeaderComponent={<>
        <HostStatusBanner hostId={hostId} />
        {state.kind === 'error' ? (
          <View style={{ padding: space.lg }}>
            <Banner message={`Pull requests could not be read: ${state.message}`} action={<Button label="Try again" onPress={reload} />} />
          </View>
        ) : null}
      </>}
      ListEmptyComponent={state.kind === 'loading' && listing === null ? (
        <View style={{ padding: space.xl }}><ActivityIndicator accessibilityLabel="Reading pull requests" /></View>
      ) : state.kind === 'loaded' ? (
        listing?.projects.length === 0
          ? <EmptyState title="No projects with a remote" message="Pull requests appear for projects whose repository is on GitHub." />
          : <EmptyState title="No open pull requests" message="Open pull requests from this host’s projects appear here. Pull to refresh." />
      ) : null}
      renderSectionHeader={({ section }) => (
        <Text accessibilityRole="header" style={{ marginTop: 14, marginBottom: 5, paddingHorizontal: 17.5, color: palette.textTertiary, fontSize: 13, fontWeight: '500' }}>
          {section.title}
        </Text>
      )}
      renderItem={({ item }) => (
        <PrRow
          item={item}
          now={now}
          onPress={() => navigation.navigate('PullRequest', { hostId, projectPath: item.projectPath, number: item.pr.number })}
        />
      )}
      ListFooterComponent={notShown.length > 0 ? (
        <View style={{ padding: 17.5, gap: space.xs }}>
          <Text accessibilityRole="header" style={{ color: palette.textTertiary, fontSize: 13, fontWeight: '500' }}>Not shown</Text>
          {notShown.map((project) => (
            <Text key={project.projectPath} style={{ color: palette.textTertiary, fontSize: 13, lineHeight: 18 }}>
              {project.kind === 'unavailable'
                ? prUnavailableTitle(project.reason, project.folderName)
                : project.kind === 'error' ? `${project.folderName}: ${project.message}` : null}
            </Text>
          ))}
        </View>
      ) : null}
    />
  )
}

/** T3 Code's row: state and number, project, and age; the title; then who
 *  wrote it, where its review stands, and how big it is. */
function PrRow({ item, now, onPress }: { item: PrRowItem; now: number; onPress: () => void }) {
  const palette = usePalette()
  const { pr } = item
  const review = reviewStatusLabel(pr.reviewStatus)
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint="Opens the pull request"
      onPress={onPress}
      style={({ pressed }) => ({ backgroundColor: pressed ? palette.accentSoft : palette.canvas })}
    >
      <View style={{ paddingHorizontal: 17.5, paddingVertical: 8.75 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <PrStateBadge pr={pr} />
          <Text numberOfLines={1} style={{ flex: 1, color: palette.textTertiary, fontSize: 14, fontWeight: '500' }}>{item.folderName}</Text>
          <Text style={{ color: palette.textTertiary, fontSize: 13, fontVariant: ['tabular-nums'] }}>{prAge(pr.updatedAt, now)}</Text>
        </View>
        <Text numberOfLines={2} style={{ marginTop: 3.5, color: palette.text, fontSize: 16, lineHeight: 23, fontWeight: '500' }}>{pr.title}</Text>
        <View style={{ marginTop: 3.5, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text numberOfLines={1} style={{ flexShrink: 1, color: palette.textTertiary, fontSize: 13 }}>{pr.author}</Text>
          {review ? <Text style={{ color: palette.textSecondary, fontSize: 13 }}>{review}</Text> : null}
          <Text style={{ marginLeft: 'auto', color: palette.textTertiary, fontSize: 12, fontFamily: CODE_FONT }}>+{pr.additions} −{pr.deletions}</Text>
        </View>
      </View>
      <View style={{ marginLeft: 17.5, height: 1, backgroundColor: palette.border, opacity: 0.6 }} />
    </Pressable>
  )
}
