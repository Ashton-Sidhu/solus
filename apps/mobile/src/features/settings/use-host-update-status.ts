import { useEffect, useState } from 'react'
import type { HostUpdateStatus } from '@solus/contracts/host-update-types'
import { useApp, useListened } from '../../app/app-context'

export interface HostVersionView {
  /** The host's Solus version, or why it is not known. */
  version: string
  /** What the host's last update check found. */
  status: HostUpdateStatus | null
}

/** A host's Solus version and update check, read while it is connected and
 *  followed through `host.updateStatusChanged`. */
export function useHostUpdateStatus(hostId: string): HostVersionView {
  const app = useApp()
  const phase = useListened(app.connections.changes, () => app.connections.state(hostId)?.phase)
  const [status, setStatus] = useState<HostUpdateStatus | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const connection = app.connections.connection(hostId)
    if (phase !== 'connected' || !connection) return
    let active = true
    connection.api.hostUpdateStatus().then(
      (next) => { if (active) { setStatus(next); setFailed(false) } },
      () => { if (active) setFailed(true) },
    )
    const stop = connection.events.subscribe('host.updateStatusChanged', (next) => { if (active) setStatus(next) })
    return () => { active = false; stop() }
  }, [app, hostId, phase])

  const version = status?.currentVersion ?? (phase === 'connected' ? (failed ? 'Unknown' : 'Checking…') : 'Not connected')
  return { version, status }
}
