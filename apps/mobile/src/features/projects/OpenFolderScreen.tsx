// Adapted from T3 Code apps/mobile/src/features/projects/AddProjectScreen.tsx (MIT, see UPSTREAM.md).
import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import { Pressable, View } from 'react-native'
import type { DirectoryEntry } from '@solus/contracts/types'
import { SymbolView } from '../../components/AppSymbol'
import { ErrorBanner } from '../../components/ErrorBanner'
import type { ScreenProps } from '../../navigation/routes'
import { HostStatusBanner } from '../hosts/HostStatusBanner'
import { AddProjectShell, ListRow, ListRowSymbol, ListSection, ListStateCard, SectionTitle } from './components/add-project-ui'
import { folderEntries, folderNameOf } from './lib/open-project'
import { errorText, useHostApi, useProjectsFolder, useShowProject } from './use-open-project'

type Listing =
  | { kind: 'loading' }
  | { kind: 'loaded'; folders: DirectoryEntry[] }
  | { kind: 'error'; message: string }

/**
 * The folders in the host's projects folder, or in `path` below it, as T3
 * Code's folder browser. A folder opens as the project; its chevron shows
 * the folders inside it.
 */
export function OpenFolderScreen({ navigation, route }: ScreenProps<'OpenFolder'>) {
  const { hostId } = route.params
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
    <AddProjectShell onRefresh={reload}>
      <HostStatusBanner hostId={hostId} />
      {listing.kind === 'error' ? <ErrorBanner message={`Folders could not be read: ${listing.message}`} /> : null}
      {listing.kind === 'error' ? <ListStateCard title="Folders unavailable" actionLabel="Try again" onAction={reload} /> : null}
      {listing.kind === 'loading' && api ? <ListStateCard title="Reading folders" loading /> : null}
      {listing.kind === 'loaded' && path && folders.length === 0 ? (
        <ListStateCard title={`No folders in ${folderNameOf(path)}`} detail="Start a new project instead, or pull to refresh." />
      ) : null}
      {folders.length > 0 ? (
        <>
          <SectionTitle>{path ? folderNameOf(path) : 'Folders'}</SectionTitle>
          <ListSection>
            {folders.map((folder, index) => (
              <ListRow
                key={folder.path}
                title={folder.name}
                subtitle={folder.branch}
                icon={<ListRowSymbol name="folder" muted />}
                isFirst={index === 0}
                accessibilityHint="Opens this folder as a project"
                onPress={() => open(folder)}
                right={(
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Folders in ${folder.name}`}
                    hitSlop={8}
                    onPress={() => navigation.push('OpenFolder', { hostId, path: folder.path })}
                    className="h-11 w-11 items-center justify-center rounded-full active:bg-subtle"
                  >
                    <View accessible={false}>
                      <SymbolView name="chevron.right" size={13} tintColorClassName="accent-chevron" type="monochrome" />
                    </View>
                  </Pressable>
                )}
              />
            ))}
          </ListSection>
        </>
      ) : null}
    </AddProjectShell>
  )
}
