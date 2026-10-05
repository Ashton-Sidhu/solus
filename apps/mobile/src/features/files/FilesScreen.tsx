import { useCallback, useEffect, useLayoutEffect, useMemo } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import { ActivityIndicator, FlatList, Pressable, RefreshControl, Text, View } from 'react-native'
import { useApp, useListened } from '../../app/app-context'
import type { ScreenProps } from '../../navigation/routes'
import { usePalette } from '../../theme/theme'
import { space } from '../../theme/tokens'
import { Banner, Button, EmptyState } from '../../ui/primitives'
import { AppSymbol } from '../../ui/app-symbol'
import { HostStatusBanner } from '../hosts/HostStatusBanner'
import { childPath, folderListing, folderTitle } from './lib/file-tree'

interface Entry {
  kind: 'folder' | 'file'
  name: string
}

/**
 * One folder of a project, folders first, as T3 Code's Files screen. A folder
 * pushes the next folder; a file opens its preview. The index is read once
 * per project and shared by every folder screen.
 */
export function FilesScreen({ navigation, route }: ScreenProps<'Files'>) {
  const { hostId, projectPath, folderPath } = route.params
  const app = useApp()
  const palette = usePalette()
  const state = useListened(app.files.changes, () => app.files.stateOf(hostId, projectPath))
  const phase = useListened(app.connections.changes, () => app.connections.state(hostId)?.phase)
  const projectName = projectPath.slice(projectPath.lastIndexOf('/') + 1) || projectPath
  const reload = useCallback(() => { void app.files.load(hostId, projectPath) }, [app, hostId, projectPath])

  useLayoutEffect(() => {
    navigation.setOptions({ title: folderTitle(folderPath, projectName) })
  }, [folderPath, navigation, projectName])

  useEffect(() => {
    if (phase === 'connected' && state.kind === 'idle') reload()
  }, [phase, reload, state.kind])

  // The root re-reads on return: a file an agent added shows without a pull.
  useFocusEffect(useCallback(() => { if (folderPath === '') reload() }, [folderPath, reload]))

  const index = state.kind === 'loaded' ? state.index : state.kind === 'idle' ? null : state.previous
  const entries = useMemo<Entry[]>(() => {
    if (!index) return []
    const listing = folderListing(index.tree, folderPath)
    return [
      ...listing.folders.map((name) => ({ kind: 'folder' as const, name })),
      ...listing.files.map((name) => ({ kind: 'file' as const, name })),
    ]
  }, [folderPath, index])

  return (
    <FlatList
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: palette.canvas }}
      data={entries}
      keyExtractor={(entry) => `${entry.kind}:${entry.name}`}
      refreshControl={<RefreshControl refreshing={state.kind === 'loading' && index !== null} onRefresh={reload} />}
      ListHeaderComponent={<>
        <HostStatusBanner hostId={hostId} />
        {state.kind === 'error' ? (
          <View style={{ padding: space.lg }}>
            <Banner message={`Files could not be read: ${state.message}`} action={<Button label="Try again" onPress={reload} />} />
          </View>
        ) : null}
      </>}
      ListEmptyComponent={state.kind === 'loading' && index === null
        ? <View style={{ padding: space.xl }}><ActivityIndicator accessibilityLabel="Reading files" /></View>
        : index ? <EmptyState title="Empty folder" message="This folder holds no files the host indexes." /> : null}
      ListFooterComponent={index?.truncated && folderPath === '' ? (
        <Text style={{ padding: 17.5, color: palette.textTertiary, fontSize: 13 }}>This project is large; the host listed only part of it.</Text>
      ) : null}
      renderItem={({ item }) => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={item.kind === 'folder' ? `Folder ${item.name}` : item.name}
          onPress={() => item.kind === 'folder'
            ? navigation.push('Files', { hostId, projectPath, folderPath: childPath(folderPath, item.name) })
            : navigation.push('File', { hostId, projectPath, path: childPath(folderPath, item.name) })}
          style={({ pressed }) => ({ backgroundColor: pressed ? palette.accentSoft : palette.canvas })}
        >
          <View style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 17.5, paddingVertical: 10 }}>
            <AppSymbol name={item.kind === 'folder' ? 'folder' : 'file'} size={18} color={item.kind === 'folder' ? palette.accent : palette.textTertiary} />
            <Text numberOfLines={1} style={{ flex: 1, color: palette.text, fontSize: 16, fontWeight: item.kind === 'folder' ? '500' : '400' }}>{item.name}</Text>
            {item.kind === 'folder' ? <AppSymbol name="chevronRight" size={14} weight="semibold" color={palette.textTertiary} /> : null}
          </View>
          <View style={{ marginLeft: 45.5, height: 1, backgroundColor: palette.border, opacity: 0.6 }} />
        </Pressable>
      )}
    />
  )
}
