import { useEffect, useState } from 'react'
import { unaddedDistros } from '@solus/client-core/wsl-distros'
import type { ForwardedHost, WslDistroList } from '@solus/contracts/remote-machines'
import { useApp, useListened } from '../../app/app-context'
import { readDistros } from './lib/wsl-add'

/** The distros a Windows host can still add, or why it has none. Read when the host is ready. */
export type WslDistrosState = { kind: 'loading' } | WslDistroList

/**
 * The WSL distros of the Windows host `hostId` that it does not reach yet
 * (docs/plans/windows.md §5.13). A distro it forwards to is in its forwarded
 * hosts already, so `forwarded` leaves it out.
 */
export function useWslDistros(hostId: string, isWindows: boolean, forwarded: readonly ForwardedHost[] | null): WslDistrosState {
  const app = useApp()
  const readiness = useListened(app.connections.changes, () => app.connections.state(hostId)?.readiness)
  const [listing, setListing] = useState<WslDistrosState>({ kind: 'loading' })

  useEffect(() => {
    const connection = app.connections.connection(hostId)
    if (!isWindows || readiness !== 'ready' || !connection) return
    let isCurrent = true
    readDistros(connection).then(
      (listed) => { if (isCurrent) setListing(listed) },
      (cause: unknown) => { if (isCurrent) setListing({ status: 'unavailable', message: cause instanceof Error ? cause.message : String(cause) }) },
    )
    return () => { isCurrent = false }
  }, [app, hostId, isWindows, readiness])

  if (!isWindows || !('status' in listing) || listing.status !== 'ready') return listing
  // Until the forwards are read, a distro could be one of them: offer none.
  if (!forwarded) return { kind: 'loading' }
  return { status: 'ready', distros: unaddedDistros(listing.distros, forwarded) }
}
