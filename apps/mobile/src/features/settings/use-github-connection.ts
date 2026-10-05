import { useCallback, useEffect, useRef, useState } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import type { DeviceCodePrompt } from '@solus/contracts/types'
import { useApp, useListened } from '../../app/app-context'
import { projectContext } from '../conversation/lib/ipc-context'

export type GithubConnectionView =
  | { kind: 'loading' }
  | { kind: 'connected'; login: string | null }
  | { kind: 'disconnected' }
  /** The host is signing in: the person enters `prompt.userCode` at its page. */
  | { kind: 'connecting'; prompt: DeviceCodePrompt | null }
  | { kind: 'error'; message: string }

/**
 * The GitHub connection the host uses for pull requests. The host holds the
 * token; the phone only starts GitHub's device sign-in on the host and shows
 * the code it streams (`provider.deviceCodeReceived`).
 */
export function useGithubConnection(hostId: string) {
  const app = useApp()
  const phase = useListened(app.connections.changes, () => app.connections.state(hostId)?.phase)
  const [view, setView] = useState<GithubConnectionView>({ kind: 'loading' })
  const connecting = useRef(false)
  const context = () => projectContext('', app.account.organizationId)

  const refresh = useCallback(() => {
    const connection = app.connections.connection(hostId)
    if (!connection || connecting.current) return
    connection.api.providerStatus(projectContext('', app.account.organizationId)).then(
      (status) => { if (!connecting.current) setView(status.connected ? { kind: 'connected', login: status.login ?? null } : { kind: 'disconnected' }) },
      (cause: unknown) => setView({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) }),
    )
  }, [app, hostId])

  useEffect(() => {
    if (phase === 'connected') refresh()
  }, [phase, refresh])

  useFocusEffect(refresh)

  const connect = async () => {
    const connection = app.connections.connection(hostId)
    if (!connection) return
    connecting.current = true
    setView({ kind: 'connecting', prompt: null })
    const stop = connection.events.subscribe('provider.deviceCodeReceived', (prompt) => {
      setView({ kind: 'connecting', prompt })
      void app.platform.openBrowser(prompt.verificationUri)
    })
    try {
      const status = await connection.api.providerConnect(context())
      setView(status.connected ? { kind: 'connected', login: status.login ?? null } : { kind: 'disconnected' })
    } catch (cause) {
      // A cancelled sign-in is the person's choice, not a failure to report.
      const message = cause instanceof Error ? cause.message : String(cause)
      setView(/cancel/i.test(message) ? { kind: 'disconnected' } : { kind: 'error', message })
    } finally {
      stop()
      connecting.current = false
    }
  }

  const cancel = () => {
    void app.connections.connection(hostId)?.api.providerCancelConnect(context())
  }

  const disconnect = async () => {
    const connection = app.connections.connection(hostId)
    if (!connection) return
    await connection.api.providerDisconnect(context())
    setView({ kind: 'disconnected' })
  }

  return { view, refresh, connect, cancel, disconnect }
}
