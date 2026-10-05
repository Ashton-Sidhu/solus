import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import { ActivityIndicator, FlatList, Pressable, RefreshControl, Text, View } from 'react-native'
import type { DirectoryEntry } from '@solus/contracts/types'
import type { ScreenProps } from '../../navigation/routes'
import { usePalette } from '../../theme/theme'
import { space, TOUCH_TARGET } from '../../theme/tokens'
import { Banner, Button, EmptyState, Row } from '../../ui/primitives'
import { HostStatusBanner } from '../hosts/HostStatusBanner'
import { folderEntries, folderNameOf } from './lib/open-project'
import { errorText, useHostApi, useProjectsFolder, useShowProject } from './use-open-project'

type Listing =
  | { kind: 'loading' }
  | { kind: 'loaded'; folders: DirectoryEntry[] }
  | { kind: 'error'; message: string }

/**
 * The folders in the host's projects folder, or in `path` below it. A folder
 * opens as the project; its chevron shows the folders inside it.
 */
export function OpenFolderScreen({ navigation, route }: ScreenProps<'OpenFolder'>) {
  const { hostId } = route.params
  const palette = usePalette()
  const api = useHostApi(hostId)
  const projectsFolder = useProjectsFolder(hostId)
  const path = route.params.path ?? projectsFolder
  const showProject = useShowProject(hostId, navigation)
  const [listing, setListing] = useState<Listing>({ kind: 'loading' })
  const [reloads, setReloads] = useState(0)
  const reload = useCallback(() => setReloads((count) => count + 1), [])

  useLayoutEffect(() => {
    if (route.params.path) navigation.setOptions({ title: folderNameOf(route.params.path) })
  }, [navigation, route.params.path])

  useEffect(() => {
    if (!api || !path) return
    let live = true
    setListing({ kind: 'loading' })
    api.listDirectory(path, false, true).then(
      (result) => {
        if (!live) return
        setListing(result.error ? { kind: 'error', message: result.error } : { kind: 'loaded', folders: folderEntries(result.entries) })
      },
      (cause: unknown) => { if (live) setListing({ kind: 'error', message: errorText(cause) }) },
    )
    return () => { live = false }
  }, [api, path, reloads])

  const open = (folder: DirectoryEntry) => {
    // Best effort: the folder opens even when the host does not record it.
    void api?.trackRecentProject(folder.path).catch(() => undefined)
    showProject(folder.path)
  }

  const folders = listing.kind === 'loaded' ? listing.folders : []
  return (
    <FlatList
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: palette.canvas }}
      data={folders}
      keyExtractor={(folder) => folder.path}
      refreshControl={<RefreshControl refreshing={false} onRefresh={reload} />}
      ListHeaderComponent={<>
        <HostStatusBanner hostId={hostId} />
        {listing.kind === 'error' ? (
          <View style={{ padding: space.lg }}>
            <Banner message={`Folders could not be read: ${listing.message}`} action={<Button label="Try again" onPress={reload} />} />
          </View>
        ) : null}
      </>}
      ListEmptyComponent={listing.kind === 'loading'
        ? (api ? <View style={{ padding: space.xl }}><ActivityIndicator accessibilityLabel="Reading folders" /></View> : null)
        : listing.kind === 'loaded' && path ? <EmptyState title={`No folders in ${folderNameOf(path)}`} message="Start a new project instead, or pull to refresh." /> : null}
      renderItem={({ item }) => (
        <Row
          title={item.name}
          subtitle={item.branch}
          accessibilityHint="Opens this folder as a project"
          onPress={() => open(item)}
          trailing={(
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Folders in ${item.name}`}
              hitSlop={8}
              onPress={() => navigation.push('OpenFolder', { hostId, path: item.path })}
              style={{ minWidth: TOUCH_TARGET, minHeight: TOUCH_TARGET, alignItems: 'center', justifyContent: 'center' }}
            >
              <Text accessible={false} style={{ color: palette.textTertiary, opacity: 0.6, fontSize: 20, fontWeight: '600' }}>›</Text>
            </Pressable>
          )}
        />
      )}
    />
  )
}
