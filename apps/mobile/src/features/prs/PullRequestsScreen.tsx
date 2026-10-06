// Adapted from T3 Code apps/mobile/src/features/archive/ArchivedThreadsScreen.tsx (MIT, see UPSTREAM.md).
import { useCallback, useEffect, useLayoutEffect, useMemo } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import { ActivityIndicator, FlatList, Pressable, RefreshControl, View } from 'react-native'
import { useApp, useListened } from '../../app/app-context'
import { SymbolView } from '../../components/AppSymbol'
import { AppText as Text } from '../../components/AppText'
import { EmptyState } from '../../components/EmptyState'
import { cn } from '../../lib/cn'
import type { ScreenProps } from '../../navigation/routes'
import { HostStatusBanner } from '../hosts/HostStatusBanner'
import { PR_STATE_TINT_CLASS, PrStateBadge } from './components/PrStateBadge'
import { hostPrSections, prAge, prStateTone, prUnavailableTitle, reviewStatusLabel, type PrRowItem } from './lib/pr-presentation'
import { shownValue } from './pull-request-directory'

type PrListItem =
  | { kind: 'section'; key: string; title: string }
  | { kind: 'pr'; key: string; item: PrRowItem; isFirst: boolean; isLast: boolean }

/**
 * The host's open pull requests across its projects, in the web's sections:
 * Authored, Review requested, Others. Grouped cards as T3 Code's archive
 * list. A project that cannot be read says why under the list instead of
 * hiding the rest.
 */
export function PullRequestsScreen({ navigation, route }: ScreenProps<'PullRequests'>) {
  const { hostId } = route.params
  const app = useApp()
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
  const items = useMemo<PrListItem[]>(() => {
    const result: PrListItem[] = []
    for (const section of hostPrSections(listing)) {
      result.push({ kind: 'section', key: `section:${section.title}`, title: section.title })
      section.data.forEach((item, index) => {
        result.push({ kind: 'pr', key: `${item.projectPath}#${item.pr.number}`, item, isFirst: index === 0, isLast: index === section.data.length - 1 })
      })
    }
    return result
  }, [listing])
  const notShown = listing?.projects.filter((project) => project.kind !== 'page') ?? []
  const now = Date.now()

  if (state.kind === 'error' && state.githubAuth) {
    return (
      <View className="flex-1 bg-sheet">
        <HostStatusBanner hostId={hostId} />
        <View className="px-4 pt-4">
          <EmptyState
            title="Connect GitHub to see pull requests"
            detail={`${host?.label ?? 'This host'} reads pull requests with its own GitHub connection.`}
            actionLabel={`Connect GitHub on ${host?.label ?? 'this host'}`}
            onAction={() => navigation.navigate('GitHubConnection', { hostId })}
          />
        </View>
      </View>
    )
  }

  return (
    <FlatList
      className="flex-1 bg-sheet"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: 32, paddingHorizontal: 16, paddingTop: 4 }}
      data={items}
      keyExtractor={(item) => item.key}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={state.kind === 'loading' && listing !== null} onRefresh={reload} />}
      ListHeaderComponent={<>
        <HostStatusBanner hostId={hostId} />
        {state.kind === 'error' ? <ListError message={state.message} onRetry={reload} /> : null}
      </>}
      ListEmptyComponent={state.kind === 'loading' && listing === null ? (
        <View className="items-center py-16">
          <ActivityIndicator colorClassName="accent-icon" />
          <Text className="mt-3 text-sm text-foreground-muted">Loading pull requests...</Text>
        </View>
      ) : state.kind === 'loaded' ? (
        listing?.projects.length === 0
          ? <EmptyState title="No projects with a remote" detail="Pull requests appear for projects whose repository is on GitHub." />
          : <EmptyState title="No open pull requests" detail="Open pull requests from this host’s projects appear here. Pull to refresh." />
      ) : undefined}
      renderItem={({ item }) => item.kind === 'section' ? (
        <View className="pt-4">
          <Text accessibilityRole="header" className="px-1 pb-2 text-xs font-t3-medium tracking-[0.5px] uppercase text-foreground-muted" numberOfLines={1}>
            {item.title}
          </Text>
        </View>
      ) : (
        <PrRow
          item={item.item}
          isLast={item.isLast}
          isFirst={item.isFirst}
          now={now}
          onPress={() => navigation.navigate('PullRequest', { hostId, projectPath: item.item.projectPath, number: item.item.pr.number })}
        />
      )}
      ListFooterComponent={notShown.length > 0 ? (
        <View className="gap-1 px-1 pt-6">
          <Text accessibilityRole="header" className="pb-1 text-xs font-t3-medium tracking-[0.5px] uppercase text-foreground-muted">Not shown</Text>
          {notShown.map((project) => (
            <Text key={project.projectPath} className="text-xs leading-snug text-foreground-tertiary">
              {project.kind === 'unavailable'
                ? prUnavailableTitle(project.reason, project.folderName)
                : project.kind === 'error' ? `${project.folderName}: ${project.message}` : null}
            </Text>
          ))}
        </View>
      ) : undefined}
    />
  )
}

/** T3 Code's archive error card. */
function ListError(props: { readonly message: string; readonly onRetry: () => void }) {
  return (
    <View className="mt-2 rounded-[20px] border border-danger-border bg-danger p-4">
      <Text className="text-base font-t3-bold text-danger-foreground">Could not read pull requests</Text>
      <Text className="mt-1 text-sm text-foreground-muted">{props.message}</Text>
      <Pressable accessibilityRole="button" className="mt-3 self-start active:opacity-60" onPress={props.onRetry}>
        <Text className="text-sm font-t3-bold text-danger-foreground">Try again</Text>
      </Pressable>
    </View>
  )
}

/** T3 Code's archived-thread row: a state tile, the title and age, then the
 *  number, project, author, review, and size. */
function PrRow({ item, isFirst, isLast, now, onPress }: { item: PrRowItem; isFirst: boolean; isLast: boolean; now: number; onPress: () => void }) {
  const { pr } = item
  const review = reviewStatusLabel(pr.reviewStatus)
  const subtitle = [item.folderName, pr.author, review, `+${pr.additions} −${pr.deletions}`].filter(Boolean).join(' · ')
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint="Opens the pull request"
      onPress={onPress}
      className={cn('overflow-hidden bg-grouped-card active:bg-subtle', isFirst && 'rounded-t-[20px]', isLast && 'rounded-b-[20px]')}
    >
      <View className={cn('flex-row items-center gap-3 px-4 py-3', !isLast && 'border-b border-separator')}>
        <View className="h-[34px] w-[34px] items-center justify-center rounded-[11px] bg-subtle">
          <SymbolView name="arrow.triangle.pull" size={15} tintColorClassName={PR_STATE_TINT_CLASS[prStateTone(pr)]} type="monochrome" />
        </View>
        <View className="min-w-0 flex-1 gap-1">
          <View className="flex-row items-center gap-2">
            <Text className="min-w-0 flex-1 text-base font-t3-bold leading-snug text-foreground" numberOfLines={1}>
              {pr.title}
            </Text>
            <Text className="min-w-[30px] text-right text-xs tabular-nums text-foreground-tertiary">{prAge(pr.updatedAt, now)}</Text>
          </View>
          <View className="flex-row items-center gap-1.5">
            <PrStateBadge pr={pr} showLabel={false} />
            <Text className="min-w-0 flex-1 text-2xs text-foreground-tertiary" numberOfLines={1}>
              {subtitle}
            </Text>
          </View>
        </View>
      </View>
    </Pressable>
  )
}
