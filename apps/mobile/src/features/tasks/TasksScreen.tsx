import { mobileTaskFilters } from './task-list'
import { tasksForSavedView } from '@solus/client-core/task-views'
import { isSessionBusyStatus } from '@solus/contracts/types'
import { threadKey } from '../threads/thread-directory'
import { useState } from 'react'
import { Alert, FlatList, RefreshControl, ScrollView, View } from 'react-native'
import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import type { TaskInvolvement } from '@solus/contracts/task-data'
import type { TaskViewFilters } from '@solus/contracts/task-views'
import { putTaskSavedView } from '@solus/contracts/task-views'
import { useApp, useListened } from '../../app/app-context'
import { AppText as Text } from '../../components/AppText'
import { MaterialScreenContent } from '../../components/MaterialScreenContent'
import type { RootStackParamList } from '../../navigation/routes'
import { TaskAction, TaskField } from './task-controls'
import { useTasks } from './use-tasks'

export function TasksScreen({
  query = '',
  onQueryChange
}: {
  query?: string
  onQueryChange: (query: string) => void
}) {
  const app = useApp(),
    navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>()
  const hosts = useListened(app.registry.changes, app.registry.hosts)
  const [chosenHost, setChosenHost] = useState<string | null>(null)
  const hostId = chosenHost ?? hosts[0]?.id
  if (!hostId)
    return (
      <MaterialScreenContent>
        <View className="gap-3 p-4">
          <Text className="text-base text-foreground">Connect a host to read tasks.</Text>
          <TaskAction onPress={() => navigation.navigate('Hosts')}>Connect host</TaskAction>
        </View>
      </MaterialScreenContent>
    )
  return (
    <TaskList
      key={hostId}
      hostId={hostId}
      query={query}
      onQueryChange={onQueryChange}
      hosts={hosts.map((host) => ({ id: host.id, label: host.label }))}
      onHost={setChosenHost}
    />
  )
}
function TaskList({
  hostId,
  query,
  onQueryChange,
  hosts,
  onHost
}: {
  hostId: string
  query: string
  onQueryChange: (query: string) => void
  hosts: Array<{ id: string; label: string }>
  onHost: (hostId: string) => void
}) {
  const app = useApp(),
    navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>()
  const settings = useListened(app.personal.changes, app.personal.current)
  const [sourceKey, setSourceKey] = useState<string | null>(null)
  const [involvement, setInvolvement] = useState<TaskInvolvement>('all')
  const [status, setStatus] = useState<'open' | 'active' | 'done' | 'all'>('all')
  const facts = useListened(app.threadList.changes, app.threadList.facts)
  const [applied, setApplied] = useState<TaskViewFilters | null>(null)
  const [renameId, setRenameId] = useState<string | null>(null)
  const [viewName, setViewName] = useState('')
  const [issueUrl, setIssueUrl] = useState('')
  const { store, state } = useTasks(hostId, query, involvement)
  const filters = mobileTaskFilters(
    { sourceKey, query, involvement, status },
    state.sources,
    applied
  )
  const runningIds = new Set(
    [...state.sessionsByTask]
      .filter(([, sessions]) =>
        sessions.some((session) =>
          isSessionBusyStatus(
            facts.liveStatus.get(
              threadKey(session.executionServerId ?? hostId, session.sessionId)
            ) ?? 'idle'
          )
        )
      )
      .map(([taskId]) => taskId)
  )
  const rows = tasksForSavedView(
    state.tasks,
    filters,
    Date.now(),
    runningIds,
    !!filters.query || filters.involvement !== 'all'
  )

  const apply = (saved: TaskViewFilters) => {
    setApplied(saved)
    setSourceKey(saved.sourceKey)
    onQueryChange(saved.query)
    setInvolvement(saved.involvement)
    setStatus('all')
  }

  return (
    <MaterialScreenContent>
      <FlatList
        data={rows}
        keyExtractor={(task) => task.id}
        refreshControl={
          <RefreshControl
            refreshing={state.pending}
            onRefresh={() => void store.load(true, query, involvement)}
          />
        }
        contentContainerStyle={{ padding: 16, gap: 8 }}
        ListHeaderComponent={
          <View className="gap-3 pb-3">
            <Text className="text-xl font-t3-medium text-foreground">Tasks</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: 8 }}
            >
              {hosts.map((host) => (
                <TaskAction
                  key={host.id}
                  selected={hostId === host.id}
                  onPress={() => onHost(host.id)}
                >
                  {host.label}
                </TaskAction>
              ))}
            </ScrollView>
            <View className="flex-row gap-2">
              <TaskAction onPress={() => navigation.navigate('TaskSources', { hostId })}>
                Sources
              </TaskAction>
              <TaskAction
                disabled={!settings.taskSources.length}
                onPress={() => navigation.navigate('TaskCreate', { hostId })}
              >
                New task
              </TaskAction>
            </View>
            <TaskField
              label="Issue URL"
              value={issueUrl}
              onChangeText={setIssueUrl}
              autoCapitalize="none"
            />
            <TaskAction
              disabled={!issueUrl.trim()}
              onPress={() =>
                void store.resolve(issueUrl).then(
                  (issue) =>
                    navigation.navigate('Task', {
                      hostId,
                      taskId: issue.details.task.id,
                      readOnly: true
                    }),
                  (error) =>
                    Alert.alert(
                      'Could not open issue',
                      error instanceof Error ? error.message : String(error)
                    )
                )
              }
            >
              Inspect issue URL
            </TaskAction>
            <TaskField
              label="Search tasks"
              value={query}
              onChangeText={onQueryChange}
              autoCapitalize="none"
            />
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: 8 }}
            >
              <TaskAction
                selected={sourceKey === null}
                onPress={() => {
                  setSourceKey(null)
                  setApplied(null)
                }}
              >
                All sources
              </TaskAction>
              {state.sources.map((source) => (
                <TaskAction
                  key={source.sourceKey}
                  selected={sourceKey === source.sourceKey}
                  onPress={() => {
                    setSourceKey(source.sourceKey)
                    setApplied(null)
                  }}
                >
                  {source.label}
                </TaskAction>
              ))}
            </ScrollView>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: 8 }}
            >
              {(['all', 'open', 'active', 'done'] as const).map((value) => (
                <TaskAction
                  key={value}
                  selected={status === value}
                  onPress={() => {
                    setStatus(value)
                    setApplied(null)
                  }}
                >
                  {value === 'all' ? 'All states' : value}
                </TaskAction>
              ))}
            </ScrollView>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: 8 }}
            >
              {(['all', 'authored', 'assigned', 'mentioned'] as const).map((value) => (
                <TaskAction
                  key={value}
                  selected={involvement === value}
                  onPress={() => setInvolvement(value)}
                >
                  {value === 'all'
                    ? 'Everyone'
                    : value === 'authored'
                      ? 'Authored by me'
                      : value === 'assigned' ? 'Assigned to me' : 'Mentioning me'}
                </TaskAction>
              ))}
            </ScrollView>
            {involvement === 'mentioned' ? (
              <Text className="text-sm text-foreground-muted">
                Mentions search covers GitHub issues. Jira and Linear do not offer a reliable
                mention filter.
              </Text>
            ) : null}
            {settings.taskSavedViews.length ? (
              <ScrollView horizontal contentContainerStyle={{ gap: 8 }}>
                {settings.taskSavedViews.map((view) => (
                  <TaskAction
                    key={view.id}
                    onPress={() =>
                      Alert.alert(view.name, 'Apply, rename or remove this saved view.', [
                        { text: 'Apply', onPress: () => apply(view.filters) },
                        {
                          text: 'Rename',
                          onPress: () => {
                            setRenameId(view.id)
                            setViewName(view.name)
                          }
                        },
                        {
                          text: 'Remove',
                          style: 'destructive',
                          onPress: () =>
                            app.personal.set({
                              taskSavedViews: settings.taskSavedViews.filter(
                                (held) => held.id !== view.id
                              )
                            })
                        },
                        { text: 'Cancel', style: 'cancel' }
                      ])
                    }
                  >
                    {view.name}
                  </TaskAction>
                ))}
              </ScrollView>
            ) : null}
            <ScrollView horizontal contentContainerStyle={{ gap: 8 }}>
              {(['overdueOnly', 'assignedOnly', 'runningOnly', 'snoozedOnly'] as const).map(
                (key) => (
                  <TaskAction
                    key={key}
                    selected={filters[key]}
                    onPress={() => setApplied({ ...filters, [key]: !filters[key] })}
                  >
                    {
                      {
                        overdueOnly: 'Overdue',
                        assignedOnly: 'Has an assignee',
                        runningOnly: 'Agent running',
                        snoozedOnly: 'Snoozed'
                      }[key]
                    }
                  </TaskAction>
                )
              )}
            </ScrollView>
            <ScrollView horizontal contentContainerStyle={{ gap: 8 }}>
              {(['updated', 'created', 'priority', 'due'] as const).map((sort) => (
                <TaskAction
                  key={sort}
                  selected={filters.sort === sort}
                  onPress={() => setApplied({ ...filters, sort })}
                >
                  Sort: {sort}
                </TaskAction>
              ))}
            </ScrollView>
            <TaskField
              label="Save current view as"
              value={viewName}
              onChangeText={setViewName}
              maxLength={100}
            />
            <TaskAction
              disabled={!viewName.trim() || (!renameId && settings.taskSavedViews.length >= 50)}
              onPress={() => {
                app.personal.set({
                  taskSavedViews: putTaskSavedView(settings.taskSavedViews, {
                    id: renameId ?? app.platform.uuid(),
                    name: viewName,
                    filters:
                      settings.taskSavedViews.find((view) => view.id === renameId)?.filters ??
                      filters
                  })
                })
                setViewName('')
                setRenameId(null)
              }}
            >
              Save view
            </TaskAction>
            {state.sources
              .filter(
                (source) => source.nextCursor && (!sourceKey || source.sourceKey === sourceKey)
              )
              .map((source) => (
                <TaskAction
                  key={source.sourceKey}
                  disabled={state.pending || state.loadingMore}
                  onPress={() =>
                    void store
                      .loadMore(source.source)
                      .catch((error) =>
                        Alert.alert(
                          'Could not load more',
                          error instanceof Error ? error.message : String(error)
                        )
                      )
                  }
                >
                  Load more · {source.label}
                </TaskAction>
              ))}
            {state.error ? (
              <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
                {state.error} Pull to retry.
              </Text>
            ) : null}
            {state.sources
              .filter((source) => source.health !== 'ok')
              .map((source) => (
                <Text key={source.sourceKey} className="text-sm text-danger-foreground">
                  {source.label}: {source.message}
                </Text>
              ))}
          </View>
        }
        renderItem={({ item }) => (
          <TaskAction onPress={() => navigation.navigate('Task', { hostId, taskId: item.id })}>
            <View className="gap-1">
              <Text className="text-base text-foreground">{item.title}</Text>
              <Text className="text-sm text-foreground-muted">
                {item.reference ?? 'Draft'} · {item.state.name}
                {item.assignees?.length
                  ? ` · ${item.assignees.map((person) => person.login).join(', ')}`
                  : ''}
              </Text>
            </View>
          </TaskAction>
        )}
        ListEmptyComponent={
          !state.pending ? (
            <Text className="py-6 text-base text-foreground-muted">
              {settings.taskSources.length
                ? 'No tasks match these filters.'
                : 'Add a task source to get started.'}
            </Text>
          ) : undefined
        }
      />
    </MaterialScreenContent>
  )
}
