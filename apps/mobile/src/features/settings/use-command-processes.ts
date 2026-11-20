import { useCallback, useEffect, useRef, useState } from 'react'
import type { Integration, IntegrationConnection, IntegrationFacts } from '@solus/contracts/integration-types'
import { commandProcessStatus, type CommandProcessActionKind, type CommandProcessStatus } from '@solus/contracts/integrations/command-server'
import { useApp, useListened } from '../../app/app-context'
import { errorMessage, type IntegrationListState } from './integrations'

/**
 * The person's processes of the commands of one host
 * (docs/plans/mcp-first-class.md §7.7), for the MCP screen: the facts of each
 * `stdio` server, read with the list and again on `integration.changed`, so a
 * start or stop on another client shows here too; and Start and test, Start
 * again, Test again, and Stop. A read starts no command. `mayRunCommands` is
 * the person's `host.admin`: without it the screen offers no add, edit, or start.
 */
export function useCommandProcesses(hostId: string, list: IntegrationListState) {
  const app = useApp()
  const readiness = useListened(app.connections.changes, () => app.connections.state(hostId)?.readiness)
  const connected = readiness === 'ready'
  const mayRunCommands = useListened(app.connections.changes, () => app.connections.may(hostId, 'host.admin'))
  const [facts, setFacts] = useState<ReadonlyMap<string, IntegrationFacts>>(new Map())
  const [starting, setStarting] = useState<ReadonlySet<string>>(new Set())
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map())
  /** Per integration: bumped by every read, so an older answer does not land. */
  const reads = useRef(new Map<string, number>())

  const connection = useCallback(() => app.connections.connection(hostId), [app, hostId])

  const put = useCallback((integrationId: string, next: IntegrationFacts) => {
    setFacts((previous) => new Map(previous).set(integrationId, next))
  }, [])

  const setError = (integrationId: string, message: string | null) => {
    setErrors((previous) => {
      const next = new Map(previous)
      if (message) next.set(integrationId, message)
      else next.delete(integrationId)
      return next
    })
  }

  const load = useCallback((integrationId: string) => {
    const current = connection()
    if (!current) return
    const read = (reads.current.get(integrationId) ?? 0) + 1
    reads.current.set(integrationId, read)
    current.api.integrationFacts({ id: integrationId }).then(
      (answer) => { if (reads.current.get(integrationId) === read) put(integrationId, answer) },
      // The row keeps the last state it read; the next event or reconnect reads again.
      () => undefined,
    )
  }, [connection, put])

  const commandIds = list.kind === 'loaded' ? list.integrations.filter((integration) => integration.kind === 'stdio').map((integration) => integration.id).join('\u0000') : ''

  // The list, a reconnect, or a change of the commands: each command's state is read again.
  useEffect(() => {
    if (!connected || !commandIds) return
    for (const integrationId of commandIds.split('\u0000')) load(integrationId)
  }, [connected, commandIds, load])

  useEffect(() => {
    const current = connected ? connection() : null
    if (!current) return
    return current.events.subscribe('integration.changed', ({ integrationId, change }) => {
      if (change !== 'removed' && commandIds.split('\u0000').includes(integrationId)) load(integrationId)
    })
  }, [connected, connection, commandIds, load])

  /** Start and test, Start again, or with `recheck` Test again. */
  const start = async (integrationId: string, recheck = false): Promise<void> => {
    const current = connection()
    if (!current || starting.has(integrationId)) return
    setStarting((previous) => new Set(previous).add(integrationId))
    setError(integrationId, null)
    // The start's answer is newer than a read in flight.
    reads.current.set(integrationId, (reads.current.get(integrationId) ?? 0) + 1)
    await current.api.integrationProcessStart({ id: integrationId, recheck }).then(
      (answer) => put(integrationId, answer),
      (cause: unknown) => {
        setError(integrationId, errorMessage(cause))
        load(integrationId)
      },
    )
    setStarting((previous) => {
      const next = new Set(previous)
      next.delete(integrationId)
      return next
    })
  }

  /** Stop, and Cancel of a start that runs: the next use starts the command again. */
  const stop = async (integrationId: string): Promise<void> => {
    const current = connection()
    if (!current) return
    setError(integrationId, null)
    await current.api.integrationProcessStop({ id: integrationId }).then(
      () => load(integrationId),
      (cause: unknown) => setError(integrationId, errorMessage(cause)),
    )
  }

  /** A command's process state for its row, or null for a server at an address. */
  const statusOf = (integration: Integration, connection: IntegrationConnection | undefined): CommandProcessStatus | null => {
    if (integration.kind !== 'stdio') return null
    return commandProcessStatus({
      facts: facts.get(integration.id),
      isStarting: starting.has(integration.id),
      mayRunCommands,
      needsValues: integration.auth.kind === 'env' && connection?.status !== 'connected',
    })
  }

  const run = (integrationId: string, kind: CommandProcessActionKind): void => {
    void (kind === 'stop' || kind === 'cancel' ? stop(integrationId) : start(integrationId, kind === 'test-again'))
  }

  return { connected, mayRunCommands, facts, starting, errors, start, stop, run, statusOf }
}
