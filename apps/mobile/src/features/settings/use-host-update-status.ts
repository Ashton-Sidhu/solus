import { useEffect, useRef, useState } from 'react'
import type { HostUpdateStatus } from '@solus/contracts/host-update-types'
import { useApp, useListened } from '../../app/app-context'

export interface HostVersionView {
  /** The host's Solus version, or why it is not known. */
  version: string
  /** What the host's last update check found. */
  status: HostUpdateStatus | null
  /** True while a check, install, or cancel request waits for the host. */
  requesting: boolean
  /** Why the last request failed, or null. */
  error: string | null
  check: () => void
  install: () => void
  cancel: () => void
}

type UpdateCommand = 'hostCheckForUpdates' | 'hostInstallUpdate' | 'hostCancelUpdate'

/** A host's Solus version and update check, read while it is connected and
 *  followed through `host.updateStatusChanged`. The commands ask the host to
 *  check, to install its Solus update, or to cancel one that waits. */
export function useHostUpdateStatus(hostId: string): HostVersionView {
  const app = useApp()
  const readiness = useListened(app.connections.changes, () => app.connections.state(hostId)?.readiness)
  const [status, setStatus] = useState<HostUpdateStatus | null>(null)
  const [failed, setFailed] = useState(false)
  const [requesting, setRequesting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Bumped by each connection: an answer from an earlier one does not land. */
  const epoch = useRef(0)

  useEffect(() => {
    const read = ++epoch.current
    setRequesting(false)
    const connection = app.connections.connection(hostId)
    if (readiness !== 'ready' || !connection) return
    connection.api.hostUpdateStatus().then(
      (next) => { if (read === epoch.current) { setStatus(next); setFailed(false) } },
      () => { if (read === epoch.current) setFailed(true) },
    )
    const stop = connection.events.subscribe('host.updateStatusChanged', (next) => { if (read === epoch.current) setStatus(next) })
    return () => { epoch.current++; stop() }
  }, [app, hostId, readiness])

  const run = (command: UpdateCommand) => {
    const connection = app.connections.connection(hostId)
    if (requesting || readiness !== 'ready' || !connection) return
    const read = epoch.current
    setRequesting(true)
    setError(null)
    connection.api[command]().then(
      (next) => { if (read === epoch.current) setStatus(next) },
      (cause: unknown) => { if (read === epoch.current) setError(cause instanceof Error ? cause.message : String(cause)) },
    ).finally(() => { if (read === epoch.current) setRequesting(false) })
  }

  const version = status?.currentVersion ?? (readiness === 'ready' ? (failed ? 'Unknown' : 'Checking…') : 'Not connected')
  return {
    version,
    status,
    requesting,
    error,
    check: () => run('hostCheckForUpdates'),
    install: () => run('hostInstallUpdate'),
    cancel: () => run('hostCancelUpdate'),
  }
}
