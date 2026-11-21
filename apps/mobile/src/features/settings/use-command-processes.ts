import { useEffect, useMemo, useState } from 'react'
import type { Integration, IntegrationConnection } from '@solus/contracts/integration-types'
import { showsFactsOnRow, type CommandProcessActionKind, type CommandProcessStatus } from '@solus/contracts/integrations/command-server'
import { CommandProcesses } from '@solus/client-core/command-processes'
import { useApp, useListened } from '../../app/app-context'
import type { IntegrationListState } from './integrations'
import { runningServers } from '../running-servers/running-servers.store'

/**
 * The person's processes of the commands of one host
 * (docs/plans/mcp-first-class.md §7.7), for the MCP screen: the client-core
 * `CommandProcesses`, the same rule as desktop and web. The facts of each
 * `stdio` server are read with the list, on a reconnect, and again on
 * `integration.changed`, so a start or stop on another client shows here too.
 * A read starts no command. `mayRunCommands` is the person's `host.admin`:
 * without it the screen offers no add, edit, or start. A server on the host's
 * loopback has facts too: whether it runs (§9.3). While the screen is open it
 * holds the host's running-servers lease, so the host follows those servers
 * and looks for new ones (§9.1); no screen, no scan.
 */
export function useCommandProcesses(hostId: string, list: IntegrationListState) {
  const app = useApp()
  const readiness = useListened(app.connections.changes, () => app.connections.state(hostId)?.readiness)
  const connected = readiness === 'ready'
  const mayRunCommands = useListened(app.connections.changes, () => app.connections.may(hostId, 'host.admin'))
  /** Bumped by each change of the processes, so the screen renders their new state. */
  const [version, setVersion] = useState(0)
  const processes = useMemo(() => new CommandProcesses({
    api: () => app.connections.connection(hostId)?.api ?? null,
    facts: new Map(),
    starting: new Set(),
    errors: new Map(),
    onChange: () => setVersion((previous) => previous + 1),
  }), [app, hostId])

  const commandIds = list.kind === 'loaded' ? list.integrations.filter(showsFactsOnRow).map((integration) => integration.id).join('\u0000') : ''

  useEffect(() => runningServers.forHost(app.connections, hostId).retain(), [app, hostId])

  // The list, a reconnect, or a change of the commands: each command's state is read again.
  useEffect(() => {
    if (!connected || !commandIds) return
    for (const integrationId of commandIds.split('\u0000')) void processes.load(integrationId)
  }, [connected, commandIds, processes])

  useEffect(() => {
    const current = connected ? app.connections.connection(hostId) : null
    if (!current) return
    return current.events.subscribe('integration.changed', ({ integrationId, change }) => {
      if (change !== 'removed' && commandIds.split('\u0000').includes(integrationId)) void processes.load(integrationId)
    })
  }, [app, hostId, connected, commandIds, processes])

  // A new object at each change: the rows read it as a new prop and render the new state.
  return useMemo(() => ({
    connected,
    mayRunCommands,
    /** Start and test, or Start again. */
    start: (integrationId: string) => processes.start(integrationId),
    run: (integrationId: string, kind: CommandProcessActionKind) => { void processes.run(integrationId, kind) },
    errorOf: (integrationId: string) => processes.errorOf(integrationId),
    /** A command's process state for its row, or null for a server at an address. */
    statusOf: (integration: Integration, connection: IntegrationConnection | undefined): CommandProcessStatus | null => processes.statusOf(integration, connection, mayRunCommands),
    isNotRunning: (integration: Integration) => processes.isNotRunning(integration),
    // `version` is read for its change: the processes changed.
  }), [connected, mayRunCommands, processes, version])
}
