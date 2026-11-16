// Adapted from T3 Code apps/mobile/src/features/threads/NewTaskRouteScreen.tsx (MIT, see UPSTREAM.md).
import { StackActions, useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { NEW_CHAT_DIRECTORY } from '@solus/contracts/chat'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ActivityIndicator, Platform, Pressable, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useApp, useListened } from '../../app/app-context'
import { AppText as Text } from '../../components/AppText'
import { SymbolView } from '../../components/AppSymbol'
import { MaterialButton } from '../../components/MaterialButton'
import { MaterialListRow } from '../../components/MaterialListRow'
import { MaterialScreenContent } from '../../components/MaterialScreenContent'
import { ProjectFavicon } from '../../components/ProjectFavicon'
import { ScreenScrollView } from '../../components/ScreenScrollView'
import { cn } from '../../lib/cn'
import type { RootStackParamList } from '../../navigation/routes'
import { useProjectHosts } from '../projects/use-project-hosts'
import { NewTaskHeader } from './NewTaskProjectHeader'
import { filterProjectScopes, getProjectScopeSelectionTarget, groupProjectScopes, preferredProjectHostId, type ProjectScope } from './new-task-project-selection'

type Navigation = NativeStackNavigationProp<RootStackParamList>

function ProjectPickerRow(props: { readonly title: string; readonly subtitle: string; readonly icon: ReactNode; readonly onPress: () => void }) {
  if (Platform.OS === 'android') {
    return <MaterialListRow className="bg-grouped-card" title={props.title} subtitle={props.subtitle} onPress={props.onPress} leading={props.icon} />
  }
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={props.title} onPress={props.onPress}
      className="flex-row items-center gap-3 bg-grouped-card px-4 py-3.5 active:opacity-70">
      <View className="h-7 w-7 items-center justify-center">{props.icon}</View>
      <View className="min-w-0 flex-1">
        <Text className="text-base leading-snug font-t3-bold">{props.title}</Text>
        <Text className="text-xs leading-snug text-foreground-muted" ellipsizeMode="middle" numberOfLines={1}>{props.subtitle}</Text>
      </View>
      <SymbolView name="chevron.right" size={14} tintColorClassName="accent-chevron" type="monochrome" />
    </Pressable>
  )
}

export function NewTaskProjectScreen(props: { readonly preferredHostId: string | null }) {
  const app = useApp()
  const navigation = useNavigation<Navigation>()
  const insets = useSafeAreaInsets()
  const [searchText, setSearchText] = useState('')
  const { choices, readyHostIds } = useProjectHosts()
  const projects = useListened(app.threads.changes, app.threads.projects)
  const loading = useListened(app.threads.changes, app.threads.isLoading)
  const listScopes = useMemo(() => groupProjectScopes(projects), [projects])
  const visibleScopes = filterProjectScopes(listScopes, searchText)
  const scratchHostId = preferredProjectHostId(choices.map((host) => host.id), props.preferredHostId, readyHostIds)
  const hasReadyHost = readyHostIds.size > 0
  const centerEmptyList = Platform.OS === 'android' && visibleScopes.length === 0
  const groupClassName = Platform.OS === 'android' ? 'overflow-hidden rounded-[28px] bg-grouped-card' : 'overflow-hidden rounded-[24px] bg-grouped-card'

  useEffect(() => { void app.threads.loadAll() }, [app])

  const selectProject = (scope: ProjectScope) => {
    const target = getProjectScopeSelectionTarget(scope, props.preferredHostId, readyHostIds)
    navigation.dispatch(StackActions.push('NewTask', { hostId: target.hostId, projectPath: target.project.path }))
  }
  const startScratch = () => {
    if (scratchHostId) navigation.dispatch(StackActions.push('NewTask', { hostId: scratchHostId, projectPath: NEW_CHAT_DIRECTORY }))
  }
  const addProject = () => {
    if (scratchHostId) navigation.navigate('OpenProject', { hostId: scratchHostId })
  }
  const emptyState = loading
    ? { title: 'Loading projects', detail: 'Reading projects from your hosts.' }
    : choices.length
      ? { title: 'No projects found', detail: 'Add a project to start a task.' }
      : { title: 'No hosts connected', detail: 'Add a host before creating a task.' }

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <NewTaskHeader title="Choose project" canAddProject={hasReadyHost} searchText={searchText} onAddProject={addProject} onSearchTextChange={setSearchText} />
      <MaterialScreenContent>
        <ScreenScrollView contentInsetAdjustmentBehavior="automatic" showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" className="flex-1"
          contentContainerStyle={{
            gap: Platform.OS === 'android' ? 8 : 12,
            paddingBottom: Math.max(insets.bottom, 18) + 18,
            paddingHorizontal: Platform.OS === 'android' ? 16 : 20,
            paddingTop: Platform.OS === 'android' ? 16 : 8,
            flexGrow: centerEmptyList ? 1 : undefined,
            justifyContent: centerEmptyList ? 'center' : undefined,
          }}>
          {scratchHostId !== null && listScopes.length > 0 ? (
            <View collapsable={false} className={groupClassName}>
              <ProjectPickerRow title="No project" subtitle="Start a task without a project" onPress={startScratch}
                icon={<SymbolView name="text.bubble" size={Platform.OS === 'android' ? 22 : 18} tintColorClassName="accent-icon-muted" type="monochrome" />} />
            </View>
          ) : null}
          {listScopes.length === 0 ? (
            <View collapsable={false} className={cn('items-center gap-3 px-6 py-8', Platform.OS !== 'android' && 'rounded-[24px] bg-grouped-card')}>
              {loading ? <ActivityIndicator colorClassName="accent-icon-muted" /> : null}
              <Text className="text-center text-lg font-t3-bold text-foreground">{emptyState.title}</Text>
              <Text className="text-center text-sm leading-normal text-foreground-muted">{emptyState.detail}</Text>
              <View className="mt-1">
                <MaterialButton label={hasReadyHost ? 'Add new project' : 'Add host'} tone="primary" onPress={() => hasReadyHost ? addProject() : navigation.navigate('Hosts')} />
              </View>
              {scratchHostId !== null ? <View><MaterialButton label="Start without a project" tone="secondary" onPress={startScratch} /></View> : null}
            </View>
          ) : visibleScopes.length === 0 ? (
            <View className="items-center gap-2 px-6 py-8">
              <Text className="text-center text-lg font-t3-bold text-foreground">No matching projects</Text>
              <Text className="text-center text-sm leading-normal text-foreground-muted">Try a different project name or workspace path.</Text>
            </View>
          ) : (
            <View collapsable={false} className={groupClassName}>
              {visibleScopes.map((scope, index) => {
                const target = getProjectScopeSelectionTarget(scope, props.preferredHostId, readyHostIds)
                return (
                  <View key={scope.key} className={cn(Platform.OS !== 'android' && index > 0 && 'border-t border-border-subtle')}>
                    <ProjectPickerRow title={scope.title} subtitle={scope.projects.length > 1 ? `${scope.projects.length} workspaces` : target.project.path}
                      onPress={() => selectProject(scope)}
                      icon={<ProjectFavicon environmentId={scope.representative.hostId} size={Platform.OS === 'android' ? 24 : 20}
                        projectTitle={scope.title} workspaceRoot={scope.representative.project.path} />} />
                  </View>
                )
              })}
            </View>
          )}
        </ScreenScrollView>
      </MaterialScreenContent>
    </View>
  )
}
