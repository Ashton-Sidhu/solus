import { useEffect, useRef, useState } from 'react'
import type { SshAddProgress, WslDistro } from '@solus/contracts/remote-machines'
import { useApp, useListened } from '../../app/app-context'
import { linkedNote } from './lib/ssh-add'
import { defaultDistro, readDistros, runWslAdd, wslAddOutcome, type WslAddOutcome } from './lib/wsl-add'

/** Where the add is: reading the distros, the choice, the host at work, its answer, or linked after it. */
export type WslAddPhase =
  | { kind: 'loading' }
  | { kind: 'form'; distros: readonly WslDistro[] }
  | { kind: 'running'; progress: readonly SshAddProgress[] }
  | WslAddOutcome
  | { kind: 'linked'; label: string; note: string }

/**
 * One "Add a WSL distro" draft for the Windows host `hostId`. The draft is
 * ephemeral, so it stays in the screen; the request and its wording are in
 * `lib/wsl-add.ts`.
 */
export function useWslAdd(hostId: string) {
  const app = useApp()
  const hostLabel = useListened(app.connections.changes, () => app.registry.host(hostId)?.label ?? 'the host')
  const [phase, setPhase] = useState<WslAddPhase>({ kind: 'loading' })
  const [distro, setDistro] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLinking, setIsLinking] = useState(false)
  const isMounted = useRef(true)
  useEffect(() => () => { isMounted.current = false }, [])

  useEffect(() => {
    const connection = app.connections.connection(hostId)
    if (!connection) {
      setPhase({ kind: 'form', distros: [] })
      setError(`${hostLabel} cannot be reached now.`)
      return
    }
    readDistros(connection).then(
      (listed) => {
        if (!isMounted.current) return
        if (listed.status === 'ready') {
          setPhase({ kind: 'form', distros: listed.distros })
          setDistro(defaultDistro(listed.distros))
        } else {
          setPhase({ kind: 'form', distros: [] })
          setError(listed.message)
        }
      },
      (cause: unknown) => {
        if (!isMounted.current) return
        setPhase({ kind: 'form', distros: [] })
        setError(cause instanceof Error ? cause.message : String(cause))
      },
    )
    // Read once per screen; the host does not gain a distro while it is open.
  }, [hostId])

  const submit = async () => {
    const connection = app.connections.connection(hostId)
    if (phase.kind !== 'form' || !distro || !connection) return
    const distros = phase.distros
    setError(null)
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
      if (!isMounted.current) return
      const outcome = wslAddOutcome(result, hostLabel)
      if (outcome.kind === 'failed') {
        setPhase({ kind: 'form', distros })
        setError(outcome.message)
      } else {
        setPhase(outcome)
      }
    } catch (cause) {
      if (!isMounted.current) return
      setPhase({ kind: 'form', distros })
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

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
  return { hostLabel, phase, distro, setDistro, error, isLinking, signedIn, submit, linkForwarded }
}
