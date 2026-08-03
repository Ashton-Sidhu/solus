import type { ClientId } from '../events/client-event-registry'

function subscriptionKey(repoRoot: string, commandId: string): string {
  return `${repoRoot}\0${commandId}`
}

/** Concrete client interests for the high-volume run-log stream. */
export class RunLogSubscriptions {
  private readonly clientIdsByRun = new Map<string, Set<ClientId>>()
  private readonly runsByClientId = new Map<ClientId, Set<string>>()

  retain(clientId: ClientId, repoRoot: string, commandId: string): void {
    const key = subscriptionKey(repoRoot, commandId)
    let clientIds = this.clientIdsByRun.get(key)
    if (!clientIds) {
      clientIds = new Set()
      this.clientIdsByRun.set(key, clientIds)
    }
    clientIds.add(clientId)

    let runs = this.runsByClientId.get(clientId)
    if (!runs) {
      runs = new Set()
      this.runsByClientId.set(clientId, runs)
    }
    runs.add(key)
  }

  release(clientId: ClientId, repoRoot: string, commandId: string): void {
    const key = subscriptionKey(repoRoot, commandId)
    const clientIds = this.clientIdsByRun.get(key)
    clientIds?.delete(clientId)
    if (clientIds?.size === 0) this.clientIdsByRun.delete(key)

    const runs = this.runsByClientId.get(clientId)
    runs?.delete(key)
    if (runs?.size === 0) this.runsByClientId.delete(clientId)
  }

  releaseClient(clientId: ClientId): void {
    const runs = this.runsByClientId.get(clientId)
    if (!runs) return
    for (const key of runs) {
      const clientIds = this.clientIdsByRun.get(key)
      clientIds?.delete(clientId)
      if (clientIds?.size === 0) this.clientIdsByRun.delete(key)
    }
    this.runsByClientId.delete(clientId)
  }

  clientIdsWatching(repoRoot: string, commandId: string): readonly ClientId[] {
    return [...(this.clientIdsByRun.get(subscriptionKey(repoRoot, commandId)) ?? [])]
  }

  clear(): void {
    this.clientIdsByRun.clear()
    this.runsByClientId.clear()
  }
}
