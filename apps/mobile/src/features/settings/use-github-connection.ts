import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'
import { useFocusEffect } from '@react-navigation/native'
import type { DeviceCodePrompt } from '@solus/contracts/types'
import { useApp, useListened } from '../../app/app-context'
import { projectContext } from '../conversation/lib/ipc-context'
import { providerAccountStatus, type AccountConnectionStatus } from './lib/account-connections'

export type GithubConnectionView =
  | { kind: 'loading' }
  | { kind: 'connected'; login: string | null }
  | { kind: 'disconnected' }
  /** The host is signing in: the person enters `prompt.userCode` at its page. */
  | { kind: 'connecting'; prompt: DeviceCodePrompt | null }
  | { kind: 'error'; message: string }
  /** The connection is in the person's Solus account; `status` is null when the phone has no account to read. */
  | { kind: 'account'; url: string; status: AccountConnectionStatus | null }

/**
 * The GitHub connection the host uses for pull requests. A signed-in person's
 * connection is in their Solus account (docs/plans/cloud-vault.md §2.5): the
 * host then names the account's Connections page, and the phone reads the
 * status from the account and opens that page. Otherwise the host holds the
 * token; the phone only starts GitHub's device sign-in on the host and shows
 * the code it streams (`provider.deviceCodeReceived`).
 */
export function useGithubConnection(hostId: string) {
  const app = useApp()
  const phase = useListened(app.connections.changes, () => app.connections.state(hostId)?.phase)
  const [view, setView] = useState<GithubConnectionView>({ kind: 'loading' })
  const connecting = useRef(false)
  const context = () => projectContext('', app.account.organizationId)

  /** Bumped by every read; an older answer does not land. */
  const reads = useRef(0)

  const refresh = useCallback(() => {
    const connection = app.connections.connection(hostId)
    if (!connection || connecting.current) return
    const read = ++reads.current
    const land = (next: GithubConnectionView) => { if (read === reads.current && !connecting.current) setView(next) }
    const fail = (cause: unknown) => land({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) })
    const readHost = () => connection.api.providerStatus(projectContext('', app.account.organizationId)).then(
      (status) => land(status.connected ? { kind: 'connected', login: status.login ?? null } : { kind: 'disconnected' }),
      fail,
    )
    // An older host has no server info: it keeps the connection itself.
    connection.api.connectionsGetServerInfo().then(async ({ accountConnectionsUrl: url }) => {
      if (!url) return readHost()
      if (!app.account.isSignedIn) return land({ kind: 'account', url, status: null })
      // A read again keeps the last answer on screen until the new one arrives.
      if (read === reads.current) setView((current) => (current.kind === 'account' && current.status?.kind !== 'failed' ? current : { kind: 'account', url, status: { kind: 'loading' } }))
      land({ kind: 'account', url, status: providerAccountStatus(await app.account.agentProfileRequests().accountVault(), 'github') })
    }, () => readHost()).catch(fail)
  }, [app, hostId])

  useEffect(() => {
    if (phase === 'connected') refresh()
  }, [phase, refresh])

  useFocusEffect(refresh)

  // People connect on the account's website: read again when the app comes back.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => { if (state === 'active') refresh() })
    return () => subscription.remove()
  }, [refresh])

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
