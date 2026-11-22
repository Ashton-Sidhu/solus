import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import type { FoundFile, DiscoveredHost, DiscoveredHostResult, FoundPlace, FoundServer, FoundServerList, IntegrationFoundAddResult, IntegrationFoundChange, IntegrationToolSummary } from '@solus/contracts/integration-types'
import { randomId } from '@solus/client-core/random-id'
import { useApp, useListened } from '../../app/app-context'
import { errorMessage, isUnsupportedMethodError } from './integrations'
import { runningServers } from '../running-servers/running-servers.store'

export type FoundServersList =
  | { kind: 'loading' }
  | { kind: 'loaded'; servers: FoundServer[]; files: FoundFile[]; portScan?: FoundServerList['portScan']; mayChange: boolean }
  | { kind: 'error'; message: string }
  | { kind: 'unsupported' }

/** A test of a found server: it runs, it read the tools, or it failed with why. */
export type FoundTest = { kind: 'running' } | { kind: 'tools'; tools: IntegrationToolSummary[] } | { kind: 'failed'; message: string }

/** The found servers of one host, and its actions: what one section of the screen shows. */
export interface FoundServersModel {
  readonly host: DiscoveredHost
  readonly list: FoundServersList
  /** The screen's host is connected: it reads every host and carries every action. */
  readonly connected: boolean
  readonly refreshing: boolean
  readonly adding: string | null
  readonly changing: string | null
  readonly tests: ReadonlyMap<string, FoundTest>
  refresh(): void
  add(server: FoundServer, useFileValues: boolean): Promise<IntegrationFoundAddResult | { kind: 'failed'; message: string }>
  test(server: FoundServer): Promise<void>
  closeTest(foundId: string): void
  change(server: FoundServer, place: FoundPlace, kind: IntegrationFoundChange): Promise<string | null>
}

/** Every host's section, the screen's host first; `self` also gives the Installed rows their file actions. */
export interface FoundServersHosts {
  readonly hosts: readonly FoundServersModel[]
  readonly self: FoundServersModel
}

/** The key of one host in a discovery: the screen's host has no id there. */
const keyOf = (host: DiscoveredHost) => host.hostId ?? ''

/** A failed read: an older host does not know the method. */
function failedList(message: string): FoundServersList {
  return isUnsupportedMethodError(message) ? { kind: 'unsupported' } : { kind: 'error', message }
}

function listOf(result: DiscoveredHostResult): FoundServersList {
  if (result.kind === 'failed') return { kind: 'error', message: result.message }
  if (result.kind === 'unsupported') return { kind: 'unsupported' }
  const { servers, files, portScan, mayChange } = result.list
  return { kind: 'loaded', servers, files, portScan, mayChange: mayChange === true }
}

/**
 * The MCP servers in the config files of the screen's host and of each other
 * host it reaches for the person (docs/plans/mcp-first-class.md §8.6, §8.8,
 * §8.9), the same capability as On your hosts on desktop and web. The screen's
 * host asks the others: each host's list shows as soon as it arrives, and an
 * action on another host goes there through the screen's host. Opening a file
 * is the exception: a phone has no editor for a file of the host. No value of
 * a file reaches this phone. It reads again when an integration changes, when
 * the host's running servers change, on focus, and on reconnect.
 */
export function useFoundServers(hostId: string): FoundServersHosts {
  const app = useApp()
  const readiness = useListened(app.connections.changes, () => app.connections.state(hostId)?.readiness)
  const connected = readiness === 'ready'
  const self: DiscoveredHost = useMemo(() => ({ hostId: null, label: '' }), [])
  const [order, setOrder] = useState<readonly DiscoveredHost[]>([self])
  const [lists, setLists] = useState<ReadonlyMap<string, FoundServersList>>(new Map())
  const [refreshing, setRefreshing] = useState(false)
  const [busy, setBusy] = useState<{ hostKey: string; foundId: string; kind: 'adding' | 'changing' } | null>(null)
  const [tests, setTests] = useState<ReadonlyMap<string, ReadonlyMap<string, FoundTest>>>(new Map())
  const discoveryId = useRef('')
  const connection = useCallback(() => app.connections.connection(hostId), [app, hostId])

  const setList = useCallback((host: DiscoveredHost, list: FoundServersList) => {
    setLists((current) => new Map(current).set(keyOf(host), list))
    // An answer can come before the discovery's own: it names its host.
    setOrder((current) => (current.some((known) => keyOf(known) === keyOf(host)) ? current : [...current, host]))
  }, [])

  const discover = useCallback((refresh = false) => {
    const current = connection()
    if (!current) return
    const at = randomId()
    discoveryId.current = at
    setRefreshing(true)
    current.api.integrationDiscover({ discoveryId: at, refresh: refresh || undefined }).then(
      ({ hosts }) => {
        if (at !== discoveryId.current) return
        // A host the screen's host no longer reaches leaves the screen.
        setOrder(hosts)
        setRefreshing(false)
      },
      (cause: unknown) => {
        if (at !== discoveryId.current) return
        const message = errorMessage(cause)
        if (!isUnsupportedMethodError(message)) {
          setList(self, { kind: 'error', message })
          setRefreshing(false)
          return
        }
        // A host older than discovery reads only its own files.
        setOrder([self])
        current.api.integrationFoundList({ refresh: refresh || undefined }).then(
          (list) => { if (at === discoveryId.current) setList(self, listOf({ kind: 'loaded', list })) },
          (cause: unknown) => { if (at === discoveryId.current) setList(self, failedList(errorMessage(cause))) },
        ).finally(() => { if (at === discoveryId.current) setRefreshing(false) })
      },
    )
  }, [connection, self, setList])

  useFocusEffect(useCallback(() => discover(), [discover]))

  useEffect(() => {
    const current = connected ? connection() : null
    if (!current) return
    const stops = [
      current.events.subscribe('integration.discovered', (event) => {
        if (event.discoveryId === discoveryId.current) setList(event.host, listOf(event.result))
      }),
      current.events.subscribe('integration.changed', () => discover()),
    ]
    discover(true)
    return () => { for (const stop of stops) stop() }
  }, [connected, connection, discover, setList])

  // The screen holds the lease (`useIntegrations`); a changed list can start or stop a server on the loopback.
  useEffect(() => runningServers.forHost(app.connections, hostId).subscribe(() => discover()), [app, hostId, discover])

  const setTest = useCallback((hostKey: string, foundId: string, test: FoundTest | null) => {
    setTests((current) => {
      const host = new Map(current.get(hostKey) ?? [])
      if (test) host.set(foundId, test)
      else host.delete(foundId)
      return new Map(current).set(hostKey, host)
    })
  }, [])

  const hosts = useMemo(() => order.map((host): FoundServersModel => {
    const hostKey = keyOf(host)
    // Another host by its id; the screen's own host gets no id, and a phone reads no project.
    const target = host.hostId ? { hostId: host.hostId } : {}
    return {
      host,
      list: lists.get(hostKey) ?? { kind: 'loading' },
      connected,
      refreshing,
      adding: busy?.hostKey === hostKey && busy.kind === 'adding' ? busy.foundId : null,
      changing: busy?.hostKey === hostKey && busy.kind === 'changing' ? busy.foundId : null,
      tests: tests.get(hostKey) ?? new Map(),
      refresh: () => discover(true),
      /** Adds what the person saw; the host refuses an entry that changed since, and the lists read again. */
      add: async (server, useFileValues) => {
        const current = connection()
        if (!current) return { kind: 'failed', message: 'This host is not connected.' }
        setBusy({ hostKey, foundId: server.foundId, kind: 'adding' })
        const result = await current.api.integrationFoundAdd({ foundId: server.foundId, fingerprint: server.fingerprint, ...target, useFileValues: useFileValues || undefined }).then(
          (answer) => answer,
          (cause: unknown) => ({ kind: 'failed' as const, message: errorMessage(cause) }),
        )
        setBusy(null)
        // The screen's host reads again on its own `integration.changed`; another host's change does not reach this phone.
        if (result.kind === 'found-changed' || host.hostId) discover(true)
        return result
      },
      /** Starts the server once on its host and reads its tools; nothing is saved. */
      test: async (server) => {
        const current = connection()
        if (!current) return
        setTest(hostKey, server.foundId, { kind: 'running' })
        await current.api.integrationFoundTest({ foundId: server.foundId, fingerprint: server.fingerprint, ...target }).then(
          (result) => {
            if (result.kind === 'tools') return setTest(hostKey, server.foundId, { kind: 'tools', tools: result.tools })
            setTest(hostKey, server.foundId, { kind: 'failed', message: 'It changed in its file. Read it again before you test it.' })
            discover(true)
          },
          (cause: unknown) => setTest(hostKey, server.foundId, { kind: 'failed', message: errorMessage(cause) }),
        )
      },
      closeTest: (foundId) => setTest(hostKey, foundId, null),
      /** Turns the server off or on in one file, or deletes it there. The error's words, or null when it is done. */
      change: async (server, place, kind) => {
        const current = connection()
        if (!current) return 'This host is not connected.'
        setBusy({ hostKey, foundId: server.foundId, kind: 'changing' })
        const error = await current.api.integrationFoundChange({
          foundId: server.foundId,
          fingerprint: server.fingerprint,
          ...target,
          place: { file: place.file, path: place.path, name: place.name },
          change: kind,
        }).then(
          (result) => (result.kind === 'found-changed' ? 'It changed in its file. Read it again, then try again.' : null),
          (cause: unknown) => errorMessage(cause),
        )
        setBusy(null)
        discover(true)
        return error
      },
    }
  }), [order, lists, connected, refreshing, busy, tests, discover, connection, setTest])

  return { hosts, self: hosts.find((host) => host.host.hostId === null) ?? hosts[0]! }
}

/** The servers found on a host that On your hosts lists: the ones Solus does not have. An added one is on the Installed list. */
export function notAddedServers(servers: readonly FoundServer[]): FoundServer[] {
  return servers.filter((server) => server.state !== 'added')
}

/** The found server an installed integration came from, for its file actions. */
export function foundForIntegration(model: FoundServersModel, integrationId: string): FoundServer | null {
  if (model.list.kind !== 'loaded' || !model.list.mayChange) return null
  return model.list.servers.find((server) => server.state === 'added' && server.integrationId === integrationId) ?? null
}
