import type { HostApi } from '@solus/client-core/host-api'
import { subscribeAllHosts } from '@solus/client-core/host-events'
import { serverConnections } from '@solus/client-core/server-connections'
import { isSolusApiId } from '@solus/contracts/uplink'
import { serversStore } from '../connections/servers.store.svelte'
import { hosts } from '../hosts/hosts.svelte'

/**
 * The hosts that the codebases store reads and writes. A codebase names a host
 * by its installation id, the one id that all clients and all hosts share
 * (docs/plans/codebases.md decision 2). A `serverId` is local to this client:
 * the desktop calls its own machine `local`.
 */

/** One machine of this client that can run work. */
export interface CodebaseMachine {
  serverId: string
  /** The id that a root names this host by. Null until this client knows it. */
  installationId: string | null
  label: string
  /** This client can do work on the host now. */
  isReady: boolean
}

export type CodebaseHostApi = Pick<HostApi, 'codebaseList' | 'codebaseSave' | 'codebaseMembers' | 'codebaseScanFolder'>

export interface CodebaseHostAccess {
  /** Each execution host of this client. The workspace service is not one: it keeps no codebases. */
  machines(): CodebaseMachine[]
  /** This client's id for the host with this installation id, or the id unchanged when no host has it. */
  resolveId(installationId: string): string
  api(serverId: string): CodebaseHostApi
  onReadinessChange(listener: (serverId: string, isReady: boolean) => void): () => void
  onCodebasesChanged(listener: (serverId: string) => void): () => void
}

function installationIdOf(serverId: string): string | null {
  // The host's own answer first; the saved host entry until it answers.
  const serverInfo = hosts.get(serverId).serverInfo
  if (serverInfo.state === 'ready') return serverInfo.value.installationId
  const listed = serversStore.hostFor(serverId)
  return listed && 'installationId' in listed ? listed.installationId ?? null : null
}

export const liveCodebaseHostAccess: CodebaseHostAccess = {
  machines: () => {
    // The connections are not reactive; the host list is, and it changes when they do.
    void serversStore.servers
    return serverConnections.serverIds()
      .filter((serverId) => !isSolusApiId(serverId) && hosts.hasExecution(serverId))
      .map((serverId) => ({
        serverId,
        installationId: installationIdOf(serverId),
        label: serversStore.hostFor(serverId)?.label ?? serverConnections.connectionFor(serverId)?.target.label ?? serverId,
        isReady: serversStore.readinessFor(serverId).readiness === 'ready',
      }))
  },
  resolveId: (installationId) => serverConnections.resolveId(installationId),
  api: (serverId) => serverConnections.apiFor(serverId),
  onReadinessChange: (listener) =>
    serverConnections.onReadinessChange((serverId, readiness) => listener(serverConnections.resolveId(serverId), readiness === 'ready')),
  onCodebasesChanged: (listener) => subscribeAllHosts('codebases.changed', (serverId) => listener(serverId)),
}
