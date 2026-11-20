import { useEffect, useRef, useState } from 'react'
import type { HostUpdateStatus } from '@solus/contracts/host-update-types'
import type { SetupAgent } from '@solus/contracts/types'
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
  installProvider: (agent: SetupAgent, installation?: 'native' | 'existing') => void
}

type UpdateCommand =
  | { kind: 'host'; method: 'hostCheckForUpdates' | 'hostInstallUpdate' | 'hostCancelUpdate' }
  | { kind: 'provider'; request: { agent: SetupAgent; installation?: 'native' | 'existing' } }

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
  const pending = useRef(false)
  const revision = useRef(0)

  useEffect(() => {
    const read = ++epoch.current
    pending.current = false
    setRequesting(false)
    setStatus(null)
    setError(null)
    setFailed(false)
    const connection = app.connections.connection(hostId)
    if (readiness !== 'ready' || !connection) return
    const generation = revision.current
    const stop = connection.events.subscribe('host.updateStatusChanged', (next) => {
      if (read === epoch.current) { revision.current++; setStatus(next); setFailed(false) }
    })
    connection.api.hostUpdateStatus().then(
      (next) => { if (read === epoch.current && generation === revision.current) { setStatus(next); setFailed(false) } },
      () => { if (read === epoch.current) setFailed(true) },
    )
    return () => { epoch.current++; stop() }
  }, [app, hostId, readiness])

  const run = (command: UpdateCommand) => {
    const connection = app.connections.connection(hostId)
    if (pending.current || readiness !== 'ready' || !connection) return
    const read = epoch.current
    const generation = revision.current
    pending.current = true
    setRequesting(true)
    setError(null)
    const request = command.kind === 'host' ? connection.api[command.method]()
      : connection.api.setupInstallAgentCli(command.request).then(() => connection.api.hostUpdateStatus())
    request.then(
      (next) => { if (read === epoch.current && generation === revision.current) setStatus(next) },
      (cause: unknown) => { if (read === epoch.current) setError(cause instanceof Error ? cause.message : String(cause)) },
    ).finally(() => { if (read === epoch.current) { pending.current = false; setRequesting(false) } })
  }

  const version = status?.currentVersion ?? (readiness === 'ready' ? (failed ? 'Unknown' : 'Checking…') : 'Not connected')
  return {
    version,
    status,
    requesting,
    error,
    check: () => run({ kind: 'host', method: 'hostCheckForUpdates' }),
    install: () => run({ kind: 'host', method: 'hostInstallUpdate' }),
    cancel: () => run({ kind: 'host', method: 'hostCancelUpdate' }),
    installProvider: (agent, installation) => run({ kind: 'provider', request: { agent, installation } }),
  }
}
