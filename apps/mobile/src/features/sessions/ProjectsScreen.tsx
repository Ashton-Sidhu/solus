import { useCallback, useEffect, useLayoutEffect } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import { FlatList, Pressable, RefreshControl, Text } from 'react-native'
import { useApp, useListened } from '../../app/app-context'
import type { ScreenProps } from '../../navigation/routes'
import { usePalette } from '../../theme/theme'
import { TOUCH_TARGET } from '../../theme/tokens'
import { Banner, EmptyState, Row } from '../../ui/primitives'
import { HostStatusBanner } from '../hosts/HostStatusBanner'
import { NEW_CHAT_DIRECTORY } from '@solus/contracts/chat'

/** The host's chats and projects; each opens its sessions. */
export function ProjectsScreen({ navigation, route }: ScreenProps<'Projects'>) {
  const { hostId } = route.params
  const app = useApp()
  const palette = usePalette()
  const host = useListened(app.registry.changes, () => app.registry.host(hostId))
  const state = useListened(app.sessions.changes, () => app.sessions.projectsOf(hostId))
  const phase = useListened(app.connections.changes, () => app.connections.state(hostId)?.phase)

  useLayoutEffect(() => {
    navigation.setOptions({
      title: host?.label ?? 'Projects',
      headerRight: () => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open project"
          hitSlop={8}
          onPress={() => navigation.navigate('OpenProject', { hostId })}
          style={({ pressed }) => ({ minWidth: TOUCH_TARGET, minHeight: TOUCH_TARGET, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.6 : 1 })}
        >
          <Text accessible={false} style={{ color: palette.accent, fontSize: 28, fontWeight: '400' }}>+</Text>
        </Pressable>
      ),
    })
  }, [host?.label, hostId, navigation, palette.accent])

  useEffect(() => {
    // Reload when the host (re)connects: a new server session may have new projects.
    if (phase === 'connected' || phase === undefined) void app.sessions.loadProjects(hostId)
  }, [app, hostId, phase])

  // A project added on the host while this screen was covered shows on return.
  useFocusEffect(useCallback(() => { void app.sessions.loadProjects(hostId) }, [app, hostId]))

  const items = state.kind === 'loaded' ? state.items : state.kind === 'idle' ? [] : state.previous ?? []
  return (
    <FlatList
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: palette.canvas }}
      data={items}
      keyExtractor={(project) => project.path}
      ListHeaderComponent={<>
        <HostStatusBanner hostId={hostId} />
        <Row title="Chats" subtitle="Ask anything, no project needed" onPress={() => navigation.navigate('Workspace', { hostId, projectPath: NEW_CHAT_DIRECTORY })} />
        <Row title="Pull requests" subtitle="Open pull requests across this host's projects" onPress={() => navigation.navigate('PullRequests', { hostId })} />
        <Row title="App builds" subtitle="Install an agent's build on this phone or a device" onPress={() => navigation.navigate('Builds', { hostId })} />
        {state.kind === 'error' ? <Banner message={`Projects could not be read: ${state.message}`} /> : null}
      </>}
      ListEmptyComponent={state.kind === 'loaded'
        ? <EmptyState title="No projects on this host yet" message="Tap + to start a new project or open a folder." />
        : null}
      refreshControl={<RefreshControl refreshing={state.kind === 'loading'} onRefresh={() => void app.sessions.loadProjects(hostId)} />}
      renderItem={({ item }) => (
        <Row
          title={item.folderName}
          subtitle={item.path}
          onPress={() => navigation.navigate('Workspace', { hostId, projectPath: item.path })}
        />
      )}
    />
  )
}
