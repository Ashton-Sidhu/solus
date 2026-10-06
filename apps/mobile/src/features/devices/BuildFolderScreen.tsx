import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import { Alert } from 'react-native'
import type { DirectoryEntry } from '@solus/contracts/types'
import { isBuildOutput } from '@solus/client-core/device-builds'
import { ErrorBanner } from '../../components/ErrorBanner'
import type { ScreenProps } from '../../navigation/routes'
import { HostStatusBanner } from '../hosts/HostStatusBanner'
import { AddProjectShell, ListRow, ListRowSymbol, ListSection, ListStateCard, SectionTitle } from '../projects/components/add-project-ui'
import { folderNameOf } from '../projects/lib/open-project'
import { errorText, useHostApi, useProjectsFolder } from '../projects/use-open-project'
import { deviceErrorText } from './use-device-state'

type Listing =
  | { kind: 'loading' }
  | { kind: 'loaded'; entries: DirectoryEntry[] }
  | { kind: 'error'; message: string }

/**
 * Add a build that is already on the host: its folders, browsed as Open
 * folder does, and the build outputs in them. An `.app` bundle is a folder,
 * so it is chosen, not opened; an `.apk` is a file. Choosing one adds it and
 * goes back to the builds.
 */
export function BuildFolderScreen({ navigation, route }: ScreenProps<'BuildFolder'>) {
  const { hostId } = route.params
  const api = useHostApi(hostId)
  const projectsFolder = useProjectsFolder(hostId)
  const path = route.params.path ?? projectsFolder
  const [listing, setListing] = useState<Listing>({ kind: 'loading' })
  const [adding, setAdding] = useState<string | null>(null)
  const [reloads, setReloads] = useState(0)
  const reload = useCallback(() => setReloads((count) => count + 1), [])

  useLayoutEffect(() => {
    if (route.params.path) navigation.setOptions({ title: folderNameOf(route.params.path) })
  }, [navigation, route.params.path])

  useEffect(() => {
    if (!api || !path) return
    let live = true
    setListing({ kind: 'loading' })
    api.listDirectory(path, false, false).then(
      (result) => {
        if (!live) return
        const entries = result.entries.filter((entry) => !entry.name.startsWith('.') && (entry.isDir || isBuildOutput(entry)))
        setListing(result.error ? { kind: 'error', message: result.error } : { kind: 'loaded', entries })
      },
      (cause: unknown) => { if (live) setListing({ kind: 'error', message: errorText(cause) }) },
    )
    return () => { live = false }
  }, [api, path, reloads])

  const choose = async (entry: DirectoryEntry) => {
    if (!api || adding) return
    setAdding(entry.path)
    try {
      await api.deviceBuildImport({ path: entry.path })
      navigation.popTo('Builds', { hostId })
    } catch (cause) {
      Alert.alert('Could not add the build', deviceErrorText(cause))
    } finally {
      setAdding(null)
    }
  }

  const entries = listing.kind === 'loaded' ? listing.entries : []
  return (
    <AddProjectShell onRefresh={reload}>
      <HostStatusBanner hostId={hostId} />
      {listing.kind === 'error' ? <ErrorBanner message={`Folders could not be read: ${listing.message}`} /> : null}
      {listing.kind === 'error' ? <ListStateCard title="Folders unavailable" actionLabel="Try again" onAction={reload} /> : null}
      {listing.kind === 'loading' && api ? <ListStateCard title="Reading folders" loading /> : null}
      {listing.kind === 'loaded' && path && entries.length === 0 ? (
        <ListStateCard title={`Nothing to add in ${folderNameOf(path)}`} detail="Builds are .app bundles and .apk files." />
      ) : null}
      {entries.length > 0 ? (
        <>
          <SectionTitle>{path ? folderNameOf(path) : 'Folders'}</SectionTitle>
          <ListSection>
            {entries.map((entry, index) => {
              const isBuild = isBuildOutput(entry)
              return (
                <ListRow
                  key={entry.path}
                  title={entry.name}
                  subtitle={adding === entry.path ? 'Adding...' : null}
                  icon={<ListRowSymbol name={isBuild ? 'hammer' : 'folder'} muted={!isBuild} />}
                  isFirst={index === 0}
                  disabled={adding !== null}
                  accessibilityHint={isBuild ? 'Adds this build' : 'Shows what is in this folder'}
                  onPress={() => (isBuild ? void choose(entry) : navigation.push('BuildFolder', { hostId, path: entry.path }))}
                />
              )
            })}
          </ListSection>
        </>
      ) : null}
    </AddProjectShell>
  )
}
