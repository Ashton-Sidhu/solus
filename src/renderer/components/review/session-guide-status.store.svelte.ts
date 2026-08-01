import { SvelteMap } from 'svelte/reactivity'
import type { SessionGuideStatusEvent } from '../../../shared/review'
import type { IpcContext, Session } from '../../../shared/types'

type SolusApi = typeof window.solus

export function sessionGuideIdentity(
  session: Session | undefined,
): { repoRoot: string; key: string } | null {
  const repoRoot = session?.gitContext?.repoRoot
  const sessionId = session?.agentSessionId
  return repoRoot && sessionId
    ? { repoRoot, key: `session-${sessionId}` }
    : null
}

function statusKey(repoRoot: string, key: string): string {
  return `${repoRoot}::${key}`
}

class SessionGuideStatusStore {
  private statusesByApi = new SvelteMap<SolusApi, SvelteMap<string, SessionGuideStatusEvent>>()
  private subscribedApis = new WeakSet<SolusApi>()
  private requestedByApi = new WeakMap<SolusApi, Set<string>>()

  bind(api: SolusApi): void {
    if (this.subscribedApis.has(api)) return
    this.subscribedApis.add(api)
    api.onSessionGuideStatus((event) => this.set(api, event))
  }

  async load(
    api: SolusApi,
    ctx: IpcContext,
    identity: { repoRoot: string; key: string },
  ): Promise<void> {
    this.bind(api)
    let requested = this.requestedByApi.get(api)
    if (!requested) {
      requested = new Set()
      this.requestedByApi.set(api, requested)
    }
    const key = statusKey(identity.repoRoot, identity.key)
    if (requested.has(key)) return
    requested.add(key)
    try {
      const event = await api.sessionGuideStatus(ctx)
      if (event) this.set(api, event)
    } catch {
      requested.delete(key)
    }
  }

  set(api: SolusApi, event: SessionGuideStatusEvent): void {
    let statuses = this.statusesByApi.get(api)
    if (!statuses) {
      statuses = new SvelteMap()
      this.statusesByApi.set(api, statuses)
    }
    statuses.set(statusKey(event.repoRoot, event.key), event)
  }

  statusFor(
    api: SolusApi,
    identity: { repoRoot: string; key: string } | null,
  ): SessionGuideStatusEvent | null {
    if (!identity) return null
    return this.statusesByApi
      .get(api)
      ?.get(statusKey(identity.repoRoot, identity.key)) ?? null
  }

  isRunningFor(api: SolusApi, session: Session | undefined): boolean {
    const status = this.statusFor(api, sessionGuideIdentity(session))?.status
    return status === 'queued' || status === 'generating'
  }
}

export const sessionGuideStatusStore = new SessionGuideStatusStore()
