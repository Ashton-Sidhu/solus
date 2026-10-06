// Adapted from T3 Code apps/mobile/src/features/files/FileTreeBrowser.tsx (MIT, see UPSTREAM.md).
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import { ActivityIndicator, FlatList, Pressable, RefreshControl, View } from 'react-native'
import { useApp, useListened } from '../../app/app-context'
import { SymbolView } from '../../components/AppSymbol'
import { AppText as Text } from '../../components/AppText'
import { cn } from '../../lib/cn'
import type { ScreenProps } from '../../navigation/routes'
import { HostStatusBanner } from '../hosts/HostStatusBanner'
import { folderTitle, visibleTreeRows, type FileTreeRow as FileTreeRowItem } from './lib/file-tree'

const FILE_TREE_INITIAL_RENDER_COUNT = 20
const FILE_TREE_RENDER_BATCH_SIZE = 12

const FileTreeRow = memo(function FileTreeRow(props: {
  readonly item: FileTreeRowItem
  readonly expanded: boolean
  readonly onPressFolder: (path: string) => void
  readonly onPressFile: (path: string) => void
}) {
  const { item } = props
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={item.kind === 'folder' ? `Folder ${item.path}` : item.path}
      accessibilityState={item.kind === 'folder' ? { expanded: props.expanded } : undefined}
      onPress={() => (item.kind === 'folder' ? props.onPressFolder(item.path) : props.onPressFile(item.path))}
      className="mx-2 min-h-[42px] flex-row items-center gap-2 rounded-[12px] px-2 active:bg-subtle"
      style={{ paddingLeft: 8 + item.depth * 18 }}
    >
      {item.kind === 'folder' ? (
        <SymbolView
          name={props.expanded ? 'chevron.down' : 'chevron.right'}
          size={12}
          tintColorClassName="accent-icon-muted"
          type="monochrome"
        />
      ) : (
        <View className="w-3" />
      )}
      <SymbolView
        name={item.kind === 'folder' ? 'folder' : 'doc.text'}
        size={17}
        tintColorClassName="accent-icon-subtle"
        type="monochrome"
      />
      <Text className="min-w-0 flex-1 text-sm leading-normal font-t3-medium text-foreground-secondary" numberOfLines={1}>
        {item.name}
      </Text>
      {item.kind === 'folder' ? (
        <Text className="text-2xs font-t3-medium text-foreground-tertiary">{item.childCount}</Text>
      ) : null}
    </Pressable>
  )
})

/**
 * A project's files as T3 Code's file tree: folders expand in place, a file
 * opens its preview, and the header search filters the whole index. The
 * index is read once per project and shared with every file screen.
 */
export function FilesScreen({ navigation, route }: ScreenProps<'Files'>) {
  const { hostId, projectPath, folderPath } = route.params
  const app = useApp()
  const state = useListened(app.files.changes, () => app.files.stateOf(hostId, projectPath))
  const phase = useListened(app.connections.changes, () => app.connections.state(hostId)?.phase)
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(() => new Set())
  const [searchQuery, setSearchQuery] = useState('')
  const projectName = projectPath.slice(projectPath.lastIndexOf('/') + 1) || projectPath
  const reload = useCallback(() => { void app.files.load(hostId, projectPath) }, [app, hostId, projectPath])

  useLayoutEffect(() => {
    navigation.setOptions({
      title: folderTitle(folderPath, projectName),
      headerSearchBarOptions: {
        placeholder: 'Search files',
        autoCapitalize: 'none',
        hideWhenScrolling: false,
        onChangeText: (event) => setSearchQuery(event.nativeEvent.text),
        onCancelButtonPress: () => setSearchQuery(''),
      },
    })
  }, [folderPath, navigation, projectName])

  useEffect(() => {
    if (phase === 'connected' && state.kind === 'idle') reload()
  }, [phase, reload, state.kind])

  // The tree re-reads on return: a file an agent added shows without a pull.
  useFocusEffect(reload)

  const index = state.kind === 'loaded' ? state.index : state.kind === 'idle' ? null : state.previous
  const rows = useMemo(
    () => (index ? visibleTreeRows(index.tree, folderPath, expandedPaths, searchQuery) : []),
    [expandedPaths, folderPath, index, searchQuery],
  )
  const error = state.kind === 'error' ? state.message : null
  const isPending = state.kind === 'loading'

  const toggleFolder = useCallback((path: string) => {
    setExpandedPaths((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])
  const openFile = useCallback(
    (path: string) => navigation.push('File', { hostId, projectPath, path }),
    [hostId, navigation, projectPath],
  )
  const renderItem = useCallback(
    ({ item }: { readonly item: FileTreeRowItem }) => (
      <FileTreeRow item={item} expanded={expandedPaths.has(item.path)} onPressFolder={toggleFolder} onPressFile={openFile} />
    ),
    [expandedPaths, openFile, toggleFolder],
  )

  return (
    <FlatList
      alwaysBounceVertical
      className="flex-1 bg-sheet"
      data={rows}
      keyExtractor={(item) => item.path}
      contentInsetAdjustmentBehavior="automatic"
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      initialNumToRender={FILE_TREE_INITIAL_RENDER_COUNT}
      maxToRenderPerBatch={FILE_TREE_RENDER_BATCH_SIZE}
      updateCellsBatchingPeriod={16}
      windowSize={5}
      contentContainerStyle={{ paddingTop: 8, paddingBottom: 8 }}
      refreshControl={<RefreshControl refreshing={isPending && index !== null} onRefresh={reload} />}
      renderItem={renderItem}
      ListHeaderComponent={
        <>
          <HostStatusBanner hostId={hostId} />
          {error && index ? (
            <Text accessibilityRole="alert" className="mx-4 my-2 text-xs text-foreground-muted">
              {error}
            </Text>
          ) : null}
          {index?.truncated ? (
            <Text className="mx-4 my-2 text-xs text-foreground-muted">
              This project is large; the host listed only part of it.
            </Text>
          ) : null}
        </>
      }
      ListEmptyComponent={
        <View className="px-4 py-5">
          {error && !index ? (
            <>
              <Text className="text-sm font-t3-bold text-foreground">Files unavailable</Text>
              <Text accessibilityRole="alert" className="mt-1 text-xs leading-normal text-foreground-muted">
                {error}
              </Text>
              <Pressable
                accessibilityRole="button"
                onPress={reload}
                disabled={isPending}
                className={cn('mt-3 min-h-11 self-start justify-center rounded-full bg-subtle px-4 active:opacity-70', isPending && 'opacity-50')}
              >
                <Text className="text-sm font-t3-medium text-foreground">Try again</Text>
              </Pressable>
            </>
          ) : !index ? (
            <ActivityIndicator size="small" accessibilityLabel="Reading files" />
          ) : (
            <>
              <Text className="text-sm font-t3-bold text-foreground">No files found</Text>
              <Text className="mt-1 text-xs leading-normal text-foreground-muted">
                {searchQuery.trim().length > 0 ? 'Try a different search.' : 'This folder holds no files the host indexes.'}
              </Text>
            </>
          )}
        </View>
      }
    />
  )
}
