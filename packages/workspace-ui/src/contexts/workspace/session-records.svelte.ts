import { SvelteMap } from 'svelte/reactivity'
import type { AgentActivity } from '@solus/contracts/agent-activity'
import { sessionExecutionStatus, type SessionExecution } from '@solus/contracts/session-execution'
import type { SessionTree } from '@solus/contracts/session-digest'
import { hostKey } from '@solus/client-core/host-key'
import { subscribeAllHosts } from '@solus/client-core/host-events'
import { serverConnections, type ManagedConnection } from '@solus/client-core/server-connections'
import { knownRunnerFor } from '@solus/client-core/session-runner'
import { onSessionMetaRead } from '@solus/client-core/session-meta'
import { sessionListStore } from './session-list.store.svelte'
import { sessionTreeStore } from '../sessions/session-tree.store.svelte'
import type { Session } from '@solus/contracts/types'
import { createAppContext } from '../app/create-app-context'

/**
 * Every session this client holds, keyed by Solus session id.
 *
 * A session is not a tab. It can have no tab (a headless agent, a draft that
 * just dispatched, a conversation closed while it still runs), one, or several
 * (a split chat). Tabs name a session by id and resolve it here; closing the
 * last tab on a session does not remove its record.
 *
 * The record objects are stable: event reduction, history, and the composer
 * mutate one session's properties in place, so a small update invalidates only
 * what reads that property rather than every surface reading the map.
 */
export class SessionRecords {
  byId = $state<Record<string, Session>>({})
  private readonly executions = new SvelteMap<string, SessionExecution>()
  private readonly activities = new SvelteMap<string, AgentActivity>()

  executionFor(serverId: string | null | undefined, sessionId: string, toolId = ''): SessionExecution | undefined {
    return serverId ? this.executions.get(this.executionKey(serverId, sessionId, toolId)) : undefined
  }

  activityFor(serverId: string, sessionId: string): AgentActivity | null {
    return this.activities.get(this.executionKey(serverId, sessionId, '')) ?? null
  }

  private executionKey(serverId: string, sessionId: string, toolId: string): string {
    return hostKey(serverConnections.resolveId(knownRunnerFor(serverId) ?? serverId), hostKey(sessionId, toolId))
  }

  adoptExecution(serverId: string, sessionId: string, execution: SessionExecution | undefined, toolId = ''): void {
    if (!execution) return
    const key = this.executionKey(serverId, sessionId, toolId)
    const held = this.executions.get(key)
    if (held && held.revision >= execution.revision) return
    this.executions.set(key, execution)
    if (!toolId && sessionExecutionStatus(execution) !== 'running') this.activities.delete(key)
  }

  private adoptTree(serverId: string, tree: SessionTree): void {
    for (const { record, subagentExecutions } of tree.nodes) {
      const runner = record.runnerHostId ?? serverId
      this.adoptExecution(runner, record.sessionId, record.execution)
      for (const { toolId, execution } of subagentExecutions ?? []) this.adoptExecution(runner, record.sessionId, execution, toolId)
    }
  }

  /** One stream of committed states per host, with reads to recover missed events. */
  subscribe(): () => void {
    const resets = new Map<string, () => void>()
    const bindReset = (connection: ManagedConnection) => {
      resets.get(connection.serverId)?.()
      resets.set(connection.serverId, connection.transport.onReset(() => {
        const prefix = hostKey(connection.serverId, '')
        for (const key of this.activities.keys()) if (key.startsWith(prefix)) this.activities.delete(key)
      }))
    }
    for (const serverId of serverConnections.serverIds()) {
      const connection = serverConnections.connectionFor(serverId)
      if (connection) bindReset(connection)
    }
    const stops = [
      serverConnections.onConnectionCreated(bindReset),
      subscribeAllHosts('session.executionChanged', (serverId, { sessionId, toolId, runnerHostId, execution }) => {
        this.adoptExecution(serverId, sessionId, execution, toolId)
        if (runnerHostId) this.adoptExecution(runnerHostId, sessionId, execution, toolId)
      }),
      subscribeAllHosts('session.activityChanged', (serverId, { sessionId, activity }) => {
        const key = this.executionKey(serverId, sessionId, '')
        if (activity) this.activities.set(key, activity)
        else this.activities.delete(key)
      }),
      sessionListStore.onRecordsRead((serverId, records) => {
        for (const record of records) {
          this.adoptExecution(serverId, record.sessionId, record.execution)
          if (record.runnerHostId) this.adoptExecution(record.runnerHostId, record.sessionId, record.execution)
        }
      }),
      onSessionMetaRead((serverId, meta) => this.adoptExecution(serverId, meta.sessionId, meta.execution)),
      sessionTreeStore.onTreeRead((serverId, tree) => this.adoptTree(serverId, tree)),
    ]
    return () => {
      for (const stop of stops) stop()
      for (const stop of resets.values()) stop()
    }
  }

  /**
   * Move a record to the id of the saved session it opens. Refuses when another record
   * already answers to that id: re-keying would evict a live object out from
   * under whatever points at it. Tabs holding the old id are the caller's to
   * repoint — records do not know which tabs exist.
   */
  rekey(fromSessionId: string, toSessionId: string): boolean {
    const session = this.byId[fromSessionId]
    if (!session || fromSessionId === toSessionId || this.byId[toSessionId]) return false
    delete this.byId[fromSessionId]
    session.id = toSessionId
    this.byId[toSessionId] = session
    return true
  }
}

export const [getSessionRecords, setSessionRecords] = createAppContext<SessionRecords>('session-records')
