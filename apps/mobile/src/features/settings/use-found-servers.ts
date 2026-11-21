import { useCallback, useEffect, useRef, useState } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import type { FoundFile, FoundServer, FoundServerList, IntegrationFoundAddResult } from '@solus/contracts/integration-types'
import { useApp, useListened } from '../../app/app-context'
import { errorMessage, isUnsupportedMethodError } from './integrations'
import { runningServers } from '../running-servers/running-servers.store'

export type FoundServersList =
  | { kind: 'loading' }
  | { kind: 'loaded'; servers: FoundServer[]; files: FoundFile[]; portScan?: FoundServerList['portScan'] }
  | { kind: 'error'; message: string }
  | { kind: 'unsupported' }

/**
 * The MCP servers in the config files of one host, and those that run on its
 * loopback (docs/plans/mcp-first-class.md §8.6, §9.2): the list, Refresh, and
 * the add, the same capability as the Found on this host view on desktop and
 * web. The host reads its own files and probes its own loopback; no value of
 * them reaches this phone. The list reads again when an integration changes,
 * when the host's running servers change, on focus, and on reconnect.
 */
export function useFoundServers(hostId: string) {
  const app = useApp()
  const readiness = useListened(app.connections.changes, () => app.connections.state(hostId)?.readiness)
  const connected = readiness === 'ready'
  const [list, setList] = useState<FoundServersList>({ kind: 'loading' })
  const [refreshing, setRefreshing] = useState(false)
  const [adding, setAdding] = useState<string | null>(null)
  const request = useRef(0)
  const connection = useCallback(() => app.connections.connection(hostId), [app, hostId])

  const load = useCallback((refresh = false) => {
    const current = connection()
    if (!current) return
    const at = ++request.current
    if (refresh) setRefreshing(true)
    current.api.integrationFoundList({ refresh: refresh || undefined }).then(
      ({ servers, files, portScan }) => {
        if (at !== request.current) return
        setList({ kind: 'loaded', servers, files, portScan })
        setRefreshing(false)
      },
      (cause: unknown) => {
        if (at !== request.current) return
        const message = errorMessage(cause)
        setList(isUnsupportedMethodError(message) ? { kind: 'unsupported' } : { kind: 'error', message })
        setRefreshing(false)
      },
    )
  }, [connection])

  useFocusEffect(useCallback(() => load(), [load]))

  useEffect(() => {
    const current = connected ? connection() : null
    if (!current) return
    load(true)
    return current.events.subscribe('integration.changed', () => load())
  }, [connected, connection, load])

  // The screen holds the lease (`useIntegrations`); a changed list can start or stop a server on the loopback.
  useEffect(() => runningServers.forHost(app.connections, hostId).subscribe(() => load()), [app, hostId, load])

  /** Adds what the person saw; the host refuses an entry that changed since, and the list reads again. */
  const add = useCallback(async (server: FoundServer, useFileValues: boolean): Promise<IntegrationFoundAddResult | { kind: 'failed'; message: string }> => {
    const current = connection()
    if (!current) return { kind: 'failed', message: 'This host is not connected.' }
    setAdding(server.foundId)
    const result = await current.api.integrationFoundAdd({ foundId: server.foundId, fingerprint: server.fingerprint, useFileValues: useFileValues || undefined }).then(
      (answer) => answer,
      (cause: unknown) => ({ kind: 'failed' as const, message: errorMessage(cause) }),
    )
    setAdding(null)
    if (result.kind === 'found-changed') load(true)
    return result
  }, [connection, load])

  return { list, connected, refreshing, adding, refresh: () => load(true), add }
}
