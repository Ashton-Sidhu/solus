import { useEffect, useRef, useState } from 'react'
import type { SshAddProgress } from '@solus/contracts/remote-machines'
import { useApp, useListened } from '../../app/app-context'
import { linkedNote, runSshAdd, sshAddFormIssue, sshAddOutcome, sshRunnerChoices, type SshAddOutcome, type SshRunner } from './lib/ssh-add'

/** Where the add is: the form, the runner host at work, or its answer. */
export type SshAddPhase =
  | { kind: 'form' }
  | { kind: 'running'; progress: readonly SshAddProgress[] }
  | SshAddOutcome

/**
 * One "Add a machine over SSH" draft. The draft is ephemeral, so it stays in
 * the screen; the request, its wording, and the runner choice are in
 * `lib/ssh-add.ts`.
 */
export function useSshAdd(preferredHostId: string | undefined) {
  const app = useApp()
  const signedIn = useListened(app.account.changes, () => app.account.isSignedIn)
  // A string, so the snapshot is stable between reads; the hosts come from it below.
  const runnerIds = useListened(app.connections.changes, () => {
    const hosts = app.registry.hosts().map((host) => ({ hostId: host.id, label: host.label, lastConnected: host.lastConnected }))
    const canRun = (hostId: string) => app.connections.state(hostId)?.readiness === 'ready' && app.connections.may(hostId, 'host.local.reach')
    return sshRunnerChoices(hosts, canRun, preferredHostId).map((host) => host.hostId).join('\n')
  })
  const runners: SshRunner[] = runnerIds
    ? runnerIds.split('\n').flatMap((hostId) => {
        const host = app.registry.host(hostId)
        return host ? [{ hostId, label: host.label, lastConnected: host.lastConnected }] : []
      })
    : []

  const [chosenHostId, setChosenHostId] = useState<string | null>(null)
  const [sshTarget, setSshTarget] = useState('')
  const [linkChoice, setLinkChoice] = useState<boolean | null>(null)
  const [authSecret, setAuthSecret] = useState('')
  const [phase, setPhase] = useState<SshAddPhase>({ kind: 'form' })
  const [error, setError] = useState<string | null>(null)
  const [isLinking, setIsLinking] = useState(false)
  const isMounted = useRef(true)
  useEffect(() => () => { isMounted.current = false }, [])

  // A chosen host that disconnected falls back to the default.
  const runner = runners.find((host) => host.hostId === chosenHostId) ?? runners[0] ?? null
  // Linking is the default when signed in; it is not possible signed out.
  const shouldLink = signedIn && (linkChoice ?? true)
  const form = { runnerHostId: runner?.hostId ?? null, sshTarget, shouldLink, authSecret }
  const issue = sshAddFormIssue(form)
  const isRunning = phase.kind === 'running'

  const submit = async () => {
    if (issue || isRunning || !runner) return
    const connection = app.connections.connection(runner.hostId)
    if (!connection) {
      setError(`${runner.label} cannot be reached now.`)
      return
    }
    setError(null)
    setPhase({ kind: 'running', progress: [] })
    try {
      const result = await runSshAdd(connection, form, {
        requestId: app.platform.uuid(),
        deviceLabel: app.platform.deviceLabel,
        issueTicket: () => app.account.issueEnrollmentTicket(),
        onProgress: (event) => {
          if (!isMounted.current) return
          setPhase((current) => current.kind === 'running' ? { kind: 'running', progress: [...current.progress, event] } : current)
        },
      })
      if (!isMounted.current) return
      const outcome = sshAddOutcome(result, runner.label, shouldLink)
      if (outcome.kind === 'linked') void app.account.refreshDirectory()
      if (outcome.kind === 'ask-target') setSshTarget(outcome.defaultTarget)
      setPhase(outcome)
    } catch (cause) {
      if (!isMounted.current) return
      setPhase({ kind: 'form' })
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  /** Links the machine the runner host now forwards to. */
  const linkForwarded = async () => {
    if (phase.kind !== 'forwarded' || !runner || isLinking) return
    setIsLinking(true)
    setError(null)
    const { host } = phase
    const failure = await app.forwardedHosts.link(runner.hostId, host.installationId).then(
      () => null,
      (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
    )
    if (!isMounted.current) return
    setIsLinking(false)
    if (failure) setError(failure)
    else setPhase({ kind: 'linked', installationId: host.installationId, label: host.label, note: linkedNote(host.label) })
  }

  return {
    signedIn,
    runners,
    runner,
    chooseRunner: setChosenHostId,
    sshTarget,
    setSshTarget,
    shouldLink,
    setShouldLink: setLinkChoice,
    authSecret,
    setAuthSecret,
    phase,
    error,
    issue,
    isRunning,
    isLinking,
    submit,
    linkForwarded,
  }
}
