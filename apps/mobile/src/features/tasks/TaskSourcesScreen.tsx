import { tasksStoreFor } from './tasks-store'
import { parseManualTaskSource } from '@solus/client-core/task-source-input'
import { useCallback, useState, useSyncExternalStore } from 'react'
import { Linking, ScrollView, View } from 'react-native'
import { useFocusEffect } from '@react-navigation/native'
import { MAX_TASK_SOURCES, taskSourceKey, type TaskSource } from '@solus/contracts/task-sources'
import type { TaskSourceOptions } from '@solus/contracts/task-types'
import { useApp, useListened } from '../../app/app-context'
import { AppText as Text } from '../../components/AppText'
import type { ScreenProps } from '../../navigation/routes'
import { SettingsScreen } from '../settings/components/SettingsScreen'
import { TaskAction, TaskField } from './task-controls'

function choices(options: TaskSourceOptions | null): Array<{ source: TaskSource; label: string }> {
  if (!options) return []
  const rows: Array<{ source: TaskSource; label: string }> = [
    ...options.github.repositories.map((repo) => ({
      source: { kind: 'github-repo' as const, ...repo },
      label: `GitHub · ${repo.owner}/${repo.repo}`
    })),
    ...options.github.projects.map((project) => ({
      source: { kind: 'github-project' as const, owner: project.owner, number: project.number },
      label: `GitHub Project · ${project.title}`
    }))
  ]
  if (options.jira.cloudId) {
    const cloudId = options.jira.cloudId
    rows.push(
      ...options.jira.projects.map((project) => ({
        source: { kind: 'jira-project' as const, cloudId, projectKey: project.projectKey },
        label: `Jira · ${project.name}`
      }))
    )
    rows.push(
      ...options.jira.boards.map((board) => ({
        source: { kind: 'jira-board' as const, cloudId, boardId: board.boardId },
        label: `Jira board · ${board.name}`
      }))
    )
  }
  if (options.linear?.workspaceId) {
    const workspaceId = options.linear.workspaceId
    rows.push(
      ...options.linear.teams.map((team) => ({
        source: { kind: 'linear-team' as const, workspaceId, teamId: team.id, teamKey: team.key },
        label: `Linear · ${team.name}`
      }))
    )
  }
  return rows
}
export function TaskSourcesScreen({ route, navigation }: ScreenProps<'TaskSources'>) {
  const app = useApp(),
    store = tasksStoreFor(app, route.params.hostId)
  const accountOrigin = useListened(app.account.changes, () => app.account.syncAccount?.origin ?? null)
  const settings = useListened(app.personal.changes, app.personal.current)
  const state = useSyncExternalStore(
    store.subscribe,
    () => store.current,
    () => store.current
  )
  const [manual, setManual] = useState(''),
    [error, setError] = useState<string | null>(null)
  useFocusEffect(
    useCallback(() => {
      void store.loadOptions()
    }, [store])
  )
  const add = (source: TaskSource) => {
    if (settings.taskSources.length >= MAX_TASK_SOURCES) {
      setError('Remove a source before adding another.')
      return
    }
    if (settings.taskSources.some((held) => taskSourceKey(held) === taskSourceKey(source))) return
    if (app.personal.set({ taskSources: [...settings.taskSources, source] }) !== 'saved')
      setError('Could not save sources.')
  }
  const addManual = () => {
    const source = parseManualTaskSource(manual)
    if (!source) {
      setError('Enter owner/repository or a GitHub repository or Project URL.')
      return
    }
    add(source)
    setManual('')
  }
  return (
    <SettingsScreen title="Task sources">
      <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
        <Text className="text-base text-foreground-muted">
          Sources belong to you and sync with your account. Removing one leaves its tasks on the
          provider.
        </Text>
        {state.optionsPending ? (
          <Text className="text-sm text-foreground-muted">Loading available sources…</Text>
        ) : null}
        {settings.taskSources.map((source) => (
          <View key={taskSourceKey(source)} className="gap-2">
            <Text className="text-sm text-foreground">
              {state.sources.find((held) => held.sourceKey === taskSourceKey(source))?.label ??
                taskSourceKey(source)}
            </Text>
            <TaskAction
              onPress={() =>
                app.personal.set({
                  taskSources: settings.taskSources.filter(
                    (held) => taskSourceKey(held) !== taskSourceKey(source)
                  )
                })
              }
            >
              Remove source
            </TaskAction>
          </View>
        ))}
        {error || state.error ? (
          <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
            {error ?? state.error}
          </Text>
        ) : null}
        <TaskField
          label="GitHub repository or Project"
          value={manual}
          onChangeText={setManual}
          autoCapitalize="none"
        />
        <TaskAction disabled={!manual.trim()} onPress={addManual}>
          Add repository issues
        </TaskAction>
        {choices(state.options)
          .filter(
            (choice) =>
              !settings.taskSources.some(
                (source) => taskSourceKey(source) === taskSourceKey(choice.source)
              )
          )
          .map((choice) => (
            <TaskAction key={taskSourceKey(choice.source)} onPress={() => add(choice.source)}>
              {choice.label}
            </TaskAction>
          ))}
        {state.options && !state.options.github.connected ? (
          <TaskAction
            onPress={() => navigation.navigate('GitHubConnection', { hostId: route.params.hostId })}
          >
            Connect GitHub
          </TaskAction>
        ) : null}
        {state.options && !state.options.jira.connected ? (
          <Text className="text-sm text-foreground-muted">
            Connect Atlassian to list Jira projects and boards.
          </Text>
        ) : null}
        <Text className="text-sm text-foreground-muted">Manage provider connections in your Solus account.</Text>
        <TaskAction onPress={() => {
          const url = accountOrigin ? new URL('/connections', accountOrigin).toString() : null
          if (url) void Linking.openURL(url).catch(() => setError('Could not open account connections.'))
          else navigation.navigate('CloudSignIn')
        }}>{accountOrigin ? 'Open account connections' : 'Sign in to manage connections'}</TaskAction>
        <TaskAction onPress={() => void store.loadOptions()}>Refresh available sources</TaskAction>
      </ScrollView>
    </SettingsScreen>
  )
}
