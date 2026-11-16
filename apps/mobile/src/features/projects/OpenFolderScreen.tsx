// Adapted from T3 Code apps/mobile/src/features/projects/AddProjectScreen.tsx (MIT, see UPSTREAM.md).
import { useCallback, useEffect, useRef, useState } from 'react'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { View } from 'react-native'
import type { DirectoryEntry } from '@solus/contracts/types'
import { ErrorBanner } from '../../components/ErrorBanner'
import type { RootStackParamList, ScreenProps } from '../../navigation/routes'
import { AppText as Text } from '../../components/AppText'
import { HostStatusBanner } from '../hosts/HostStatusBanner'
import { AddProjectShell, AddProjectTextInput, ListRow, ListRowSymbol, ListSection, ListStateCard, PrimaryActionButton, SectionTitle } from './components/add-project-ui'
import { cloneDestinationPath, folderEntries, folderNameOf, openExistingProjectFolder } from './lib/open-project'
import { errorText, useHostApi, useMounted, useProjectsFolder, useShowProject } from './use-open-project'

type Listing =
  | { kind: 'loading' }
  | { kind: 'loaded'; requestedPath: string; path: string; parentPath: string | null; folders: DirectoryEntry[] }
  | { kind: 'error'; message: string }

/** T3's path field, Add project action and folder browser, on the selected Solus host. */
export function OpenFolderScreen({ navigation, route }: ScreenProps<'OpenFolder'>) {
  return <ProjectFolderScreen navigation={navigation} hostId={route.params.hostId} initialPath={route.params.path} />
}

export function CloneDestinationScreen({ navigation, route }: ScreenProps<'CloneDestination'>) {
  return <ProjectFolderScreen navigation={navigation} hostId={route.params.hostId} initialPath={route.params.path}
    remoteUrl={route.params.remoteUrl} repositoryTitle={route.params.repositoryTitle} />
}

function ProjectFolderScreen({ navigation, hostId, initialPath, remoteUrl, repositoryTitle }: {
  readonly navigation: NativeStackNavigationProp<RootStackParamList>;
  readonly hostId: string;
  readonly initialPath?: string;
  readonly remoteUrl?: string;
  readonly repositoryTitle?: string;
}) {
  const api = useHostApi(hostId)
  const projectsFolder = useProjectsFolder(hostId)
  const path = initialPath ?? projectsFolder
  const showProject = useShowProject(hostId, navigation)
  const mounted = useMounted()
  const [pathInput, setPathInput] = useState<string | null>(null)
  const [listing, setListing] = useState<Listing>({ kind: 'loading' })
  const [opening, setOpening] = useState(false)
  const inFlight = useRef(false)
  const [openError, setOpenError] = useState<string | null>(null)
  const [reloads, setReloads] = useState(0)
  const reload = useCallback(() => setReloads((count) => count + 1), [])
  const loaded = listing.kind === 'loaded' && listing.requestedPath === path ? listing : null
  const currentPath = loaded?.path ?? path
  const input = pathInput ?? (currentPath && remoteUrl ? cloneDestinationPath(currentPath, remoteUrl) : currentPath) ?? ''

  useEffect(() => {
    if (!api || !path) return
    let live = true
    setListing({ kind: 'loading' })
    api.listDirectory(path, false, true).then(
      (result) => {
        if (!live) return
        setListing(result.error ? { kind: 'error', message: result.error } : {
          kind: 'loaded', requestedPath: path, path: result.currentPath, parentPath: result.parentPath, folders: folderEntries(result.entries),
        })
      },
      (cause: unknown) => { if (live) setListing({ kind: 'error', message: errorText(cause) }) },
    )
    return () => { live = false }
  }, [api, path, reloads])

  const browse = (nextPath: string) => {
    setPathInput(null)
    setOpenError(null)
    navigation.setParams({ path: nextPath })
  }
  const open = async () => {
    if (!api || !input.trim() || inFlight.current) return
    inFlight.current = true
    setOpening(true)
    setOpenError(null)
    try {
      // The host resolves home paths and validates the folder before it is selected.
      const projectPath = remoteUrl
        ? (await api.setupCloneProject({ cloneUrl: remoteUrl, destination: input.trim() })).path
        : await openExistingProjectFolder(api, input)
      if (mounted.current) showProject(projectPath)
    } catch (cause) {
      if (mounted.current) setOpenError(errorText(cause))
    } finally {
      inFlight.current = false
      if (mounted.current) setOpening(false)
    }
  }

  return (
    <AddProjectShell title={remoteUrl ? 'Clone destination' : 'Local folder'} onRefresh={reload}>
      <HostStatusBanner hostId={hostId} />
      {openError ? <ErrorBanner message={openError} /> : null}
      {remoteUrl ? (
        <View className="rounded-[24px] bg-grouped-card px-4 py-3">
          {repositoryTitle ? <Text className="text-base font-t3-bold">{repositoryTitle}</Text> : null}
          <Text className="mt-0.5 text-xs text-foreground-muted" numberOfLines={2}>{remoteUrl}</Text>
        </View>
      ) : null}
      <AddProjectTextInput accessibilityLabel="Project folder" placeholder="~/projects/my-app" value={input}
        onChangeText={setPathInput} editable={!opening} returnKeyType="done" onSubmitEditing={() => void open()} />
      <PrimaryActionButton label={remoteUrl ? 'Clone project' : 'Add project'} disabled={!api || !input.trim() || opening} loading={opening} onPress={() => void open()} />
      <ProjectFolderListing listing={listing} loaded={loaded} opening={opening} reload={reload} browse={browse} isConnected={api !== null} />
    </AddProjectShell>
  )
}

function ProjectFolderListing({ listing, loaded, opening, reload, browse, isConnected }: {
  readonly listing: Listing;
  readonly loaded: Extract<Listing, { kind: 'loaded' }> | null;
  readonly opening: boolean;
  readonly reload: () => void;
  readonly browse: (path: string) => void;
  readonly isConnected: boolean;
}) {
  return (
    <>
      <SectionTitle>Browse folders</SectionTitle>
      {listing.kind === 'error' ? <ListStateCard title="Folders unavailable" detail={listing.message} actionLabel="Try again" onAction={reload} /> : null}
      {listing.kind === 'loading' && isConnected ? <ListStateCard title="Reading folders" loading /> : null}
      {loaded ? (
        <ListSection>
          {loaded.parentPath ? <ListRow title=".." icon={<ListRowSymbol name="arrow.turn.left.up" muted />} isFirst right={null} disabled={opening} onPress={() => browse(loaded.parentPath!)} /> : null}
          {loaded.folders.map((folder, index) => (
            <ListRow key={folder.path} title={folder.name} subtitle={folder.branch} icon={<ListRowSymbol name="folder" muted />}
              isFirst={!loaded.parentPath && index === 0} disabled={opening} accessibilityHint={`Browse folders in ${folder.name}`}
              onPress={() => browse(folder.path)} />
          ))}
          {loaded.folders.length === 0 ? <ListStateCard title={`No folders in ${folderNameOf(loaded.path)}`} /> : null}
        </ListSection>
      ) : null}
    </>
  )
}
