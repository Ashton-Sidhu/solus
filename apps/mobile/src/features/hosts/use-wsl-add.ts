import { useEffect, useRef, useState } from 'react'
import type { SshAddProgress } from '@solus/contracts/remote-machines'
import { useApp, useListened } from '../../app/app-context'
import { linkedNote } from './lib/ssh-add'
import { runWslAdd, wslAddOutcome, type WslAddOutcome } from './lib/wsl-add'

/** Where the add is: the host at work, its answer, or linked after it. */
export type WslAddPhase =
  | { kind: 'running'; progress: readonly SshAddProgress[] }
  | WslAddOutcome
  | { kind: 'linked'; label: string; note: string }

/**
 * The add of the distro `distro` of the Windows host `hostId`, chosen in that
 * host's settings. It starts when the screen opens. The add is ephemeral, so it
 * stays in the screen; the request and its wording are in `lib/wsl-add.ts`.
 */
export function useWslAdd(hostId: string, distro: string) {
  const app = useApp()
  const hostLabel = useListened(app.connections.changes, () => app.registry.host(hostId)?.label ?? 'the host')
  const [phase, setPhase] = useState<WslAddPhase>({ kind: 'running', progress: [] })
  const [error, setError] = useState<string | null>(null)
  const [isLinking, setIsLinking] = useState(false)
  const isMounted = useRef(true)
  useEffect(() => () => { isMounted.current = false }, [])

  const start = async () => {
    const connection = app.connections.connection(hostId)
    setError(null)
    if (!connection) {
      setPhase({ kind: 'failed', message: `${hostLabel} cannot be reached now.` })
      return
    }
    setPhase({ kind: 'running', progress: [] })
    try {
      const result = await runWslAdd(connection, distro, {
        requestId: app.platform.uuid(),
        deviceLabel: app.platform.deviceLabel,
        onProgress: (event) => {
          if (!isMounted.current) return
          setPhase((current) => current.kind === 'running' ? { kind: 'running', progress: [...current.progress, event] } : current)
        },
      })
      if (isMounted.current) setPhase(wslAddOutcome(result, hostLabel))
    } catch (cause) {
      if (isMounted.current) setPhase({ kind: 'failed', message: cause instanceof Error ? cause.message : String(cause) })
    }
  }

  // One add per screen: the distro was chosen before it opened.
  useEffect(() => { void start() }, [hostId, distro])

  /** Links the distro the Windows host now forwards to, so the phone reaches it too. */
  const linkForwarded = async () => {
    if (phase.kind !== 'forwarded' || isLinking) return
    setIsLinking(true)
    setError(null)
    const { host } = phase
    const failure = await app.forwardedHosts.link(hostId, host.installationId).then(
      () => null,
      (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
    )
    if (!isMounted.current) return
    setIsLinking(false)
    if (failure) setError(failure)
    else setPhase({ kind: 'linked', label: host.label, note: linkedNote(host.label) })
  }

  const signedIn = useListened(app.account.changes, () => app.account.isSignedIn)
  return { hostLabel, phase, error, isLinking, signedIn, retry: start, linkForwarded }
}
