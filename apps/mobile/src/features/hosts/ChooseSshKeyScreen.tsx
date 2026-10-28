import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import type { DirectoryEntry } from '@solus/contracts/types'
import { ErrorBanner } from '../../components/ErrorBanner'
import type { ScreenProps } from '../../navigation/routes'
import { AddProjectShell, ListRow, ListRowSymbol, ListSection, ListStateCard, SectionTitle } from '../projects/components/add-project-ui'
import { folderNameOf } from '../projects/lib/open-project'
import { errorText, useHostApi } from '../projects/use-open-project'
import { HostStatusBanner } from './HostStatusBanner'

type Listing =
  | { kind: 'loading' }
  | { kind: 'loaded'; entries: DirectoryEntry[] }
  | { kind: 'error'; message: string }

/**
 * The files on the host that runs SSH, from `~/.ssh` or `path`, for the
 * identity file of "Add over SSH". A folder opens; a file is the key.
 */
export function ChooseSshKeyScreen({ navigation, route }: ScreenProps<'ChooseSshKey'>) {
  const { hostId } = route.params
  const path = route.params.path ?? '~/.ssh'
  const api = useHostApi(hostId)
  const [listing, setListing] = useState<Listing>({ kind: 'loading' })
  const [reloads, setReloads] = useState(0)
  const reload = useCallback(() => setReloads((count) => count + 1), [])

  useLayoutEffect(() => {
    if (route.params.path) navigation.setOptions({ title: folderNameOf(route.params.path) })
  }, [navigation, route.params.path])

  useEffect(() => {
    if (!api) return
    let live = true
    setListing({ kind: 'loading' })
    api.listDirectory(path, false).then(
      (result) => {
        if (!live) return
        setListing(result.error ? { kind: 'error', message: result.error } : { kind: 'loaded', entries: result.entries })
      },
      (cause: unknown) => { if (live) setListing({ kind: 'error', message: errorText(cause) }) },
    )
    return () => { live = false }
  }, [api, path, reloads])

  const entries = listing.kind === 'loaded' ? listing.entries : []
  return (
    <AddProjectShell onRefresh={reload}>
      <HostStatusBanner hostId={hostId} />
      {listing.kind === 'error' ? <ErrorBanner message={`Files could not be read: ${listing.message}`} /> : null}
      {listing.kind === 'error' ? <ListStateCard title="Files unavailable" actionLabel="Try again" onAction={reload} /> : null}
      {listing.kind === 'loading' && api ? <ListStateCard title="Reading files" loading /> : null}
      {listing.kind === 'loaded' && entries.length === 0 ? (
        <ListStateCard title={`No files in ${folderNameOf(path)}`} detail="Pull to refresh, or type the path instead." />
      ) : null}
      {entries.length > 0 ? (
        <>
          <SectionTitle>{folderNameOf(path)}</SectionTitle>
          <ListSection>
            {entries.map((entry, index) => (
              <ListRow
                key={entry.path}
                title={entry.name}
                icon={<ListRowSymbol name={entry.isDir ? 'folder' : 'doc'} muted />}
                isFirst={index === 0}
                accessibilityHint={entry.isDir ? 'Shows the files in this folder' : 'Uses this file as the identity file'}
                onPress={() => entry.isDir
                  ? navigation.push('ChooseSshKey', { hostId, path: entry.path })
                  : navigation.popTo('AddSshHost', { identityFile: entry.path }, { merge: true })}
              />
            ))}
          </ListSection>
        </>
      ) : null}
    </AddProjectShell>
  )
}
