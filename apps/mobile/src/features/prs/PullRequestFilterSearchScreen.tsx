import { useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, FlatList, Platform, Pressable, View } from 'react-native'
import type { PrFilterChoice } from '@solus/contracts/providers'
import { useApp, useListened } from '../../app/app-context'
import { SymbolView } from '../../components/AppSymbol'
import { AppText as Text, AppTextInput as TextInput } from '../../components/AppText'
import { EmptyState } from '../../components/EmptyState'
import { SheetHeader } from '../../components/SheetHeader'
import type { ScreenProps } from '../../navigation/routes'
import { resolvePullRequestListScope, type PullRequestListProject } from '../workspace/list-preferences'
import { useWorkspaceTabs } from '../workspace/WorkspaceTabsContext'
import { PullRequestAvatar } from './detail/pull-request-ui'
import { pullRequestListMenuChoice } from './lib/list-filter-menu'
import { pullRequestLabelColor } from './lib/pull-request-list'
import { shownValue } from './pull-request-reads'

/** The host is asked this long after the last keystroke, as web does. */
const SEARCH_DELAY_MS = 250
/** The projects asked at most; each one is a host read. */
const MAX_PROJECTS = 10

const projectKey = (hostId: string, projectPath: string) => `${hostId}\u0000${projectPath}`

function projectOfKey(key: string): PullRequestListProject {
  const at = key.indexOf('\u0000')
  return { hostId: key.slice(0, at), projectPath: key.slice(at + 1) }
}

/**
 * Searches the hosts for a label or author to filter the Pull Requests tab
 * by, beyond the ones on the loaded rows. Labels toggle and the sheet stays;
 * an author is one choice, so picking one closes the sheet.
 */
export function PullRequestFilterSearchScreen({ navigation, route }: ScreenProps<'PullRequestFilterSearch'>) {
  const { field } = route.params
  const app = useApp()
  const { pullRequestPreferences: preferences, setPullRequestPreferences } = useWorkspaceTabs()
  const registryHosts = useListened(app.registry.changes, app.registry.hosts)
  const hostIds = useMemo(() => registryHosts.map((host) => host.id), [registryHosts])
  const scope = useMemo(() => resolvePullRequestListScope(preferences, hostIds), [preferences, hostIds])
  // The projects in the list's scope, as one string so a read that changes
  // nothing here gives the same answer.
  const projectKeys = useListened(app.pullRequests.changes, () => {
    if (scope.project) return projectKey(scope.project.hostId, scope.project.projectPath)
    return scope.hostIds
      .flatMap((hostId) => (shownValue(app.pullRequests.hostOf(hostId))?.projects ?? [])
        .flatMap((project) => (project.kind === 'page' ? [projectKey(hostId, project.projectPath)] : [])))
      .slice(0, MAX_PROJECTS)
      .join('\n')
  })
  const projects = useMemo(() => (projectKeys ? projectKeys.split('\n').map(projectOfKey) : []), [projectKeys])

  const [query, setQuery] = useState('')
  const [answer, setAnswer] = useState<{ kind: 'loading' } | { kind: 'loaded'; choices: PrFilterChoice[] }>({ kind: 'loading' })
  useEffect(() => {
    let current = true
    setAnswer({ kind: 'loading' })
    const timer = setTimeout(() => {
      void app.pullRequestActions.filterOptions(projects, field, query.trim()).then((choices) => {
        if (current) setAnswer({ kind: 'loaded', choices })
      })
    }, SEARCH_DELAY_MS)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [app, field, query, projects])

  const selected = new Set(field === 'label' ? (preferences.filters.labels?.flat() ?? []) : [preferences.filters.author ?? ''])
  const choose = (value: string) => {
    const next = pullRequestListMenuChoice(JSON.stringify([field, value]), { value: preferences, hostIds, projects: [] })
    if (!next) return
    setPullRequestPreferences(next)
    if (field === 'author') navigation.goBack()
  }
  const noun = field === 'label' ? 'labels' : 'authors'

  return (
    <View className="flex-1 bg-sheet">
      <SheetHeader
        presentation={Platform.OS === 'android' ? 'inline' : 'native'}
        title={field === 'label' ? 'Labels' : 'Author'}
        onClose={() => navigation.goBack()}
        accessibilityLabel={`Close ${noun} search`}
      />
      <FlatList
        data={answer.kind === 'loaded' ? answer.choices : []}
        keyExtractor={(choice) => choice.value}
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: 24 }}
        ListHeaderComponent={
          <View className="px-4 py-4">
            <TextInput
              accessibilityLabel={`Search ${noun}`}
              placeholder={`Search ${noun}`}
              placeholderTextColorClassName="accent-placeholder"
              value={query}
              onChangeText={setQuery}
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
              className="min-h-11 rounded-xl bg-grouped-card px-3 text-sm text-foreground"
            />
          </View>
        }
        renderItem={({ item }) => {
          const on = selected.has(item.value)
          const color = pullRequestLabelColor(item.color)
          return (
            <Pressable
              accessibilityRole={field === 'label' ? 'checkbox' : 'button'}
              accessibilityState={field === 'label' ? { checked: on } : { selected: on }}
              onPress={() => choose(item.value)}
              className="min-h-13 flex-row items-center gap-3 border-b border-border-subtle px-4 py-3 active:opacity-70"
            >
              {field === 'author'
                ? <PullRequestAvatar login={item.value} avatarUrl={item.avatarUrl ?? null} size={28} />
                : <View className="size-3 rounded-full bg-subtle" style={color ? { backgroundColor: color } : undefined} />}
              <Text className="min-w-0 flex-1 text-sm" numberOfLines={1}>{item.value}</Text>
              {on ? <SymbolView name="checkmark" size={15} tintColorClassName="accent-icon" /> : null}
            </Pressable>
          )
        }}
        ListEmptyComponent={answer.kind === 'loading' ? <ActivityIndicator className="my-8" /> : (
          <View className="px-4 py-6">
            <EmptyState
              variant="plain"
              title={query.trim() ? `No matching ${noun}` : `No ${noun}`}
              detail={projects.length === 0 ? 'Connect a host with a repository to search it.' : 'The repositories of this list have none that match.'}
            />
          </View>
        )}
      />
    </View>
  )
}
